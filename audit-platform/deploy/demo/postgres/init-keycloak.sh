#!/bin/bash
# First start only: a separate database and login for Keycloak.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username postgres -v pw="$KEYCLOAK_DB_PASSWORD" <<'SQL'
CREATE ROLE keycloak LOGIN PASSWORD :'pw';
CREATE DATABASE keycloak OWNER keycloak;
SQL
