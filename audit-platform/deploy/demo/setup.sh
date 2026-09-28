#!/usr/bin/env bash
# Creates .env for the demo with fresh random secrets. Run once per server.
#   ./setup.sh                      # asks for the domain, e-mail and API key
#   DEMO_DOMAIN=localhost ./setup.sh  # local test (https://jordan-audit.localhost)
set -euo pipefail
cd "$(dirname "$0")"
if [[ -f .env ]]; then echo ".env exists; delete it first to regenerate (this resets passwords)."; exit 1; fi
rand() { openssl rand -hex "${1:-24}"; }
word() { openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 14; }

domain="${DEMO_DOMAIN:-}"
[[ -n "$domain" ]] || read -rp "Demo domain (e.g. demo.blanketsolutions.net): " domain
if [[ "$domain" == "localhost" ]]; then
  tls=internal; extra_ca=/local-ca/root.crt
else
  tls="${ACME_EMAIL:-}"; [[ -n "$tls" ]] || read -rp "E-mail for HTTPS certificates (Let's Encrypt): " tls
  extra_ca=
fi
key="${ANTHROPIC_API_KEY:-}"
if [[ -z "$key" && -t 0 ]]; then read -rsp "Anthropic API key (Enter to skip; AI mapping stays off): " key; echo; fi

umask 077
cat > .env <<ENV
DEMO_DOMAIN=$domain
APP_HOST=jordan-audit.$domain
LOGIN_HOST=login.$domain
TLS_MODE=$tls
API_EXTRA_CA=$extra_ca
POSTGRES_PASSWORD=$(rand)
KEYCLOAK_DB_PASSWORD=$(rand)
API_DB_PASSWORD=$(rand)
KC_ADMIN_PASSWORD=$(rand)
CTX_SIGNING_KEY=$(rand 32)
JOB_ENVELOPE_KEY=$(rand 32)
DEMO_PASSWORD_PARTNER=$(word)
DEMO_PASSWORD_MANAGER=$(word)
DEMO_PASSWORD_SENIOR=$(word)
DEMO_PASSWORD_JUNIOR=$(word)
ANTHROPIC_API_KEY=$key
MAPPING_LLM_ENABLED=$([[ -n "$key" ]] && echo true || echo false)
ENV
echo "Wrote .env (keep it private). Demo sign-in accounts:"
grep '^DEMO_PASSWORD_' .env | sed 's/^DEMO_PASSWORD_\(.*\)=/  \L\1\E  password: /'
echo "Start with: docker compose up -d --build"
