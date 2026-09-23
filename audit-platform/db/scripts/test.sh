#!/usr/bin/env bash
# Creates a throwaway database, applies every migration, runs the SQL test
# suite. Requires a superuser connection (local cluster or CI service).
#
#   ADMIN_URL=postgresql://postgres@localhost:5432/postgres ./db/scripts/test.sh
#
# Set KEEP_DB=1 to keep the database afterwards (its URL is printed); the
# backend integration tests reuse it via DATABASE_URL.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${ADMIN_URL:?set ADMIN_URL to a superuser connection string}"

db="audit_test_$(date +%s)_$$"
base="${ADMIN_URL%/*}"
url="${base}/${db}"
psql_q=(psql -X -q -v ON_ERROR_STOP=1)

"${psql_q[@]}" "$ADMIN_URL" -c "CREATE DATABASE ${db}"
cleanup() {
  if [[ "${KEEP_DB:-0}" != "1" ]]; then
    "${psql_q[@]}" "$ADMIN_URL" -c "DROP DATABASE IF EXISTS ${db} WITH (FORCE)" >/dev/null
  fi
}
trap cleanup EXIT

echo "==> migrating ${db}"
for f in "$here"/migrations/V*.sql; do
  echo "    $(basename "$f")"
  "${psql_q[@]}" -1 "$url" -f "$f"
done

echo "==> test fixtures"
"${psql_q[@]}" -1 "$url" -f "$here/tests/00_fixtures.sql" >/dev/null

status=0
for f in "$here"/tests/[1-9]*.sql; do
  if "${psql_q[@]}" "$url" -f "$f" >/tmp/audit_sql_test.out 2>&1; then
    echo "PASS $(basename "$f")"
  else
    echo "FAIL $(basename "$f")"; cat /tmp/audit_sql_test.out; status=1
  fi
done

if [[ "${KEEP_DB:-0}" == "1" ]]; then echo "DATABASE_URL=${url}"; fi
exit $status
