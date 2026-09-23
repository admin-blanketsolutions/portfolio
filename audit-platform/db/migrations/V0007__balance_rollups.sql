-- =============================================================================
-- V0007 — Balance roll-ups (TB + posted AJEs -> FS lines)
-- -----------------------------------------------------------------------------
-- Why functions and not views / materialized views?
--   * MATERIALIZED VIEWS DO NOT SUPPORT RLS. A firm-wide MV of balances is a
--     cross-tenant leak waiting to happen; they are banned in this schema
--     (db/tests/10_schema_lint.sql fails the build if one appears).
--   * A plain view over a FULL JOIN cannot push an engagement filter below the
--     join, so it would aggregate the whole tenant. A parameterised SQL
--     function keeps the engagement predicate inside every branch, where the
--     covering indexes from V0003 turn it into index-only scans.
--   * All functions are SECURITY INVOKER: RLS + ethical walls still apply.
--
-- Cost model for one engagement (L TB lines, J AJE lines, A accounts, depth D):
--   account_balances: O(L + J) via tb_lines_tb_cover_ix / aje lines rollup ix.
--   fs_rollup:        O(A * D) — each balance is exploded to its D ancestors and
--                     hash-joined on path equality, instead of an O(A^2) `<@` scan.
-- =============================================================================
SET ROLE audit_owner;

CREATE FUNCTION app.account_balances(p_engagement uuid)
RETURNS TABLE (coa_account_id uuid, unadjusted numeric, aje numeric, rje numeric, adjusted numeric)
LANGUAGE sql STABLE
AS $$
  SELECT x.coa_account_id,
         sum(x.unadj), sum(x.aje), sum(x.rje),
         sum(x.unadj + x.aje + x.rje)
    FROM (
      SELECT m.coa_account_id, l.closing_balance AS unadj, 0::numeric AS aje, 0::numeric AS rje
        FROM app.trial_balances t
        JOIN app.account_mappings m
          ON m.tenant_id = t.tenant_id AND m.trial_balance_id = t.id AND m.status = 'accepted'
        JOIN app.tb_lines l
          ON l.tenant_id = m.tenant_id AND l.id = m.tb_line_id
       WHERE t.tenant_id = (SELECT app.current_tenant_id())
         AND t.engagement_id = p_engagement
         AND t.tb_kind = 'current_unadjusted' AND t.status = 'locked'
      UNION ALL
      SELECT al.coa_account_id, 0,
             CASE WHEN e.entry_type = 'AJE' THEN al.amount ELSE 0 END,
             CASE WHEN e.entry_type = 'RJE' THEN al.amount ELSE 0 END
        FROM app.adjusting_entries e
        JOIN app.adjusting_entry_lines al
          ON al.tenant_id = e.tenant_id AND al.entry_id = e.id
       WHERE e.tenant_id = (SELECT app.current_tenant_id())
         AND e.engagement_id = p_engagement
         AND e.status = 'posted' AND e.entry_type IN ('AJE', 'RJE')
    ) x
   GROUP BY x.coa_account_id
$$;

-- Full hierarchy with subtotals at every COA node (lead schedules & FS lines).
CREATE FUNCTION app.fs_rollup(p_engagement uuid)
RETURNS TABLE (path ext.ltree, code text, name_en text, name_ar text, depth int,
               fs_statement app.fs_statement, is_postable boolean,
               unadjusted numeric, aje numeric, rje numeric, adjusted numeric)
LANGUAGE sql STABLE
SET search_path = pg_catalog, ext, pg_temp      -- ltree operators live in ext
AS $$
  WITH bal AS (
    SELECT a.path, b.unadjusted, b.aje, b.rje, b.adjusted
      FROM app.account_balances(p_engagement) b
      JOIN app.coa_accounts a
        ON a.tenant_id = (SELECT app.current_tenant_id()) AND a.id = b.coa_account_id
  ), anc AS (
    SELECT ext.subpath(bal.path, 0, i) AS node, bal.unadjusted, bal.aje, bal.rje, bal.adjusted
      FROM bal, generate_series(1, ext.nlevel(bal.path)) AS i
  )
  SELECT n.path, n.code, n.name_en, n.name_ar, ext.nlevel(n.path), n.fs_statement, n.is_postable,
         coalesce(sum(anc.unadjusted), 0), coalesce(sum(anc.aje), 0),
         coalesce(sum(anc.rje), 0), coalesce(sum(anc.adjusted), 0)
    FROM app.coa_accounts n
    LEFT JOIN anc ON anc.node = n.path
   WHERE n.tenant_id = (SELECT app.current_tenant_id())
   GROUP BY n.path, n.code, n.name_en, n.name_ar, n.fs_statement, n.is_postable
   ORDER BY n.path
$$;

-- Accounting invariants FS generation must satisfy before rendering.
CREATE FUNCTION app.fs_integrity(p_engagement uuid)
RETURNS TABLE (check_name text, ok boolean, value numeric)
LANGUAGE sql STABLE
AS $$
  WITH b AS (SELECT * FROM app.account_balances(p_engagement))
  SELECT 'unadjusted TB nets to zero', coalesce(sum(unadjusted), 0) = 0, coalesce(sum(unadjusted), 0) FROM b
  UNION ALL
  SELECT 'posted adjustments net to zero', coalesce(sum(aje + rje), 0) = 0, coalesce(sum(aje + rje), 0) FROM b
  UNION ALL
  SELECT 'adjusted TB nets to zero (BS balances incl. current-year result)',
         coalesce(sum(adjusted), 0) = 0, coalesce(sum(adjusted), 0) FROM b
  UNION ALL
  SELECT 'reclassifications do not change profit',
         coalesce(sum(b.rje) FILTER (WHERE a.fs_statement IN ('IS', 'OCI')), 0) = 0,
         coalesce(sum(b.rje) FILTER (WHERE a.fs_statement IN ('IS', 'OCI')), 0)
    FROM b JOIN app.coa_accounts a
      ON a.tenant_id = (SELECT app.current_tenant_id()) AND a.id = b.coa_account_id
$$;
