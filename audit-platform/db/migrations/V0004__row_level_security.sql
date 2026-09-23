-- =============================================================================
-- V0004 — Row-Level Security
-- -----------------------------------------------------------------------------
-- Layer 1 (PERMISSIVE, every table):  tenant_id = verified ctx tenant.
-- Layer 2 (RESTRICTIVE, ANDed):       ethical walls inside a firm.
--     * Engagement content (TB, mappings, AJEs, workpapers, sign-offs,
--       evidence) is visible only to ACTIVE engagement members or to service
--       principals. Firm admins are NOT exempt: an admin who adds themselves
--       to a team to read it leaves an engagement_members row, which is
--       captured in the hash-chained audit log.
--     * Client-portal contacts (same tenant as the firm!) see only their own
--       engagements/clients and never internal workpapers, TB mappings or AJEs.
--
-- FORCE ROW LEVEL SECURITY makes the policies apply to the table owner too.
-- Partitions get RLS as well, and the app role is never granted on partitions
-- directly (querying a partition bypasses the parent's policies).
-- =============================================================================
SET ROLE audit_owner;

-- Control plane: an app session can see only its own tenant row. Not FORCEd:
-- only owner-run SECURITY DEFINER provisioning writes here; audit_app has
-- SELECT only.
ALTER TABLE platform.tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON platform.tenants
  FOR SELECT USING (id = (SELECT app.current_tenant_id()));

-- Layer 1 on every tenant-owned table in schema app (incl. partitions).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL
         USING (tenant_id = (SELECT app.current_tenant_id()))
         WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))', r.tbl);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Layer 2 — ethical walls
-- ---------------------------------------------------------------------------
-- Engagement content: members (not client contacts) or service principals.
-- The IN (sub-select) form is planned as a hashed SubPlan evaluated once per
-- statement, which matters for 10^4-row TB scans.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'app.trial_balances', 'app.tb_lines', 'app.account_mappings',
    'app.adjusting_entries', 'app.adjusting_entry_lines',
    'app.workpapers', 'app.workpaper_versions', 'app.workpaper_signoffs']
  LOOP
    EXECUTE format(
      'CREATE POLICY engagement_wall ON %s AS RESTRICTIVE FOR ALL
         USING (%s) WITH CHECK (%s)', t, $p$
           NOT (SELECT app.ctx_is_client())
           AND ( (SELECT app.ctx_is_service())
                 OR engagement_id IN (SELECT m.engagement_id FROM app.engagement_members m
                                       WHERE m.user_id = (SELECT app.current_user_id())
                                         AND m.removed_at IS NULL) )$p$, $p$
           NOT (SELECT app.ctx_is_client())
           AND ( (SELECT app.ctx_is_service())
                 OR engagement_id IN (SELECT m.engagement_id FROM app.engagement_members m
                                       WHERE m.user_id = (SELECT app.current_user_id())
                                         AND m.removed_at IS NULL) )$p$);
  END LOOP;
END
$$;

-- Evidence: members, where client contacts see only what they uploaded (PBC).
CREATE POLICY engagement_wall ON app.evidence_files AS RESTRICTIVE FOR ALL
  USING (
    (SELECT app.ctx_is_service())
    OR ( engagement_id IN (SELECT m.engagement_id FROM app.engagement_members m
                            WHERE m.user_id = (SELECT app.current_user_id()) AND m.removed_at IS NULL)
         AND (NOT (SELECT app.ctx_is_client()) OR created_by = (SELECT app.current_user_id())) ))
  WITH CHECK (
    (SELECT app.ctx_is_service())
    OR ( engagement_id IN (SELECT m.engagement_id FROM app.engagement_members m
                            WHERE m.user_id = (SELECT app.current_user_id()) AND m.removed_at IS NULL)
         AND (NOT (SELECT app.ctx_is_client()) OR created_by = (SELECT app.current_user_id())) ));

-- Engagement headers: all firm staff may see the list (needed for staffing &
-- conflict checks); client contacts only their own engagements.
CREATE POLICY client_wall ON app.engagements AS RESTRICTIVE FOR ALL
  USING (
    NOT (SELECT app.ctx_is_client())
    OR id IN (SELECT m.engagement_id FROM app.engagement_members m
               WHERE m.user_id = (SELECT app.current_user_id()) AND m.removed_at IS NULL))
  WITH CHECK (NOT (SELECT app.ctx_is_client()));

-- Membership rows: client contacts see only their own; only staff mutate.
CREATE POLICY client_wall ON app.engagement_members AS RESTRICTIVE FOR ALL
  USING (NOT (SELECT app.ctx_is_client()) OR user_id = (SELECT app.current_user_id()))
  WITH CHECK (NOT (SELECT app.ctx_is_client()));

-- Clients (audited entities): client contacts see only the entity they belong to.
CREATE POLICY client_wall ON app.clients AS RESTRICTIVE FOR ALL
  USING (
    NOT (SELECT app.ctx_is_client())
    OR id IN (SELECT e.client_id FROM app.engagements e))   -- already wall-filtered above
  WITH CHECK (NOT (SELECT app.ctx_is_client()));

-- Users directory: client contacts see only themselves.
CREATE POLICY client_wall ON app.users AS RESTRICTIVE FOR ALL
  USING (NOT (SELECT app.ctx_is_client()) OR id = (SELECT app.current_user_id()))
  WITH CHECK (NOT (SELECT app.ctx_is_client()));

-- User administration is a firm-admin function. Split per command because a
-- restrictive FOR ALL policy would also block SELECT for non-admins. No
-- self-service UPDATE: a user who could edit their own row could flip
-- is_firm_admin / professional_rank, which the backend reads when minting ctx.
CREATE POLICY admin_writes_ins ON app.users AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT app.ctx_is_firm_admin()));
CREATE POLICY admin_writes_upd ON app.users AS RESTRICTIVE FOR UPDATE
  USING ((SELECT app.ctx_is_firm_admin()));

-- Chart of accounts: staff read; firm admins write.
CREATE POLICY staff_only ON app.coa_accounts AS RESTRICTIVE FOR SELECT
  USING (NOT (SELECT app.ctx_is_client()));
CREATE POLICY admin_writes_ins ON app.coa_accounts AS RESTRICTIVE FOR INSERT
  WITH CHECK ((SELECT app.ctx_is_firm_admin()));
CREATE POLICY admin_writes_upd ON app.coa_accounts AS RESTRICTIVE FOR UPDATE
  USING ((SELECT app.ctx_is_firm_admin()));
