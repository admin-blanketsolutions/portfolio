#!/bin/bash
# Applies the schema (first start only) and the demo firm. Idempotent.
set -euo pipefail
until pg_isready -q; do sleep 1; done
psql_q=(psql -X -q -v ON_ERROR_STOP=1)

if [[ "$("${psql_q[@]}" -Atc "SELECT to_regclass('platform.tenants') IS NOT NULL")" != "t" ]]; then
  echo "==> applying migrations"
  for f in /db/migrations/V*.sql; do
    echo "    $(basename "$f")"
    "${psql_q[@]}" -1 -f "$f"
  done
fi

echo "==> demo firm"
"${psql_q[@]}" -v ctx_key_id=demo-k1 -v ctx_key="$CTX_SIGNING_KEY" -v api_password="$API_DB_PASSWORD" \
  -v issuer="https://${LOGIN_HOST}/realms/jordan-audit" -v web_client=audit-web \
  -v llm_allowed="$LLM_ALLOWED" -f /seed/demo.sql
