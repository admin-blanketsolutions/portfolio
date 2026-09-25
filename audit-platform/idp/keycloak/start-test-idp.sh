#!/usr/bin/env bash
# Starts a THROWAWAY Keycloak for the sign-in tests: HTTPS on https://localhost:8443
# with a certificate from a one-off local CA, and the two test realms imported.
# Test realms only (known passwords, no MFA); never use them for real tenants.
#
#   ./idp/keycloak/start-test-idp.sh [out-dir]    -> prints the CA file to trust
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-${TMPDIR:-/tmp}/audit-test-idp}"
image="${KEYCLOAK_IMAGE:-docker.io/keycloak/keycloak:26.3}"
mkdir -p "$out"

openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=audit test IdP CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" \
  -keyout "$out/ca.key" -out "$out/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout "$out/tls.key" -out "$out/tls.csr" 2>/dev/null
openssl x509 -req -in "$out/tls.csr" -CA "$out/ca.pem" -CAkey "$out/ca.key" -CAcreateserial -days 2 \
  -extfile <(printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n') \
  -out "$out/tls.crt" 2>/dev/null
chmod 644 "$out/tls.key"          # read by the container's non-root user; throwaway key

docker rm -f audit-test-idp >/dev/null 2>&1 || true
docker run -d --name audit-test-idp -p 127.0.0.1:8443:8443 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -hex 16)" \
  -v "$here:/opt/keycloak/data/import:ro" -v "$out:/opt/keycloak/conf/tls:ro" \
  "$image" start-dev --import-realm --http-enabled=false --https-port=8443 \
  --hostname=https://localhost:8443 \
  --https-certificate-file=/opt/keycloak/conf/tls/tls.crt --https-certificate-key-file=/opt/keycloak/conf/tls/tls.key \
  >/dev/null

for _ in $(seq 1 90); do
  if curl -sf --cacert "$out/ca.pem" https://localhost:8443/realms/beta-audit/.well-known/openid-configuration >/dev/null; then
    echo "$out/ca.pem"; exit 0
  fi
  sleep 2
done
docker logs --tail 50 audit-test-idp >&2
echo "Keycloak did not become ready" >&2
exit 1
