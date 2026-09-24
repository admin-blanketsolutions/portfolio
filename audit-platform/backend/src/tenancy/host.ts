const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/**
 * `alpha-audit.app.example.com` -> `alpha-audit` when the base domain is
 * `app.example.com`. Exactly one label is accepted: no nested subdomains, no
 * ports, no IP literals, no look-alike suffixes (`app.example.com.evil.io`).
 * The host is only a HINT: authentication binds it to the tenant's own IdP
 * issuer, so a spoofed Host header cannot move a token between tenants.
 */
export function tenantSlugFromHost(hostname: string | undefined, baseDomain: string): string | null {
  if (!hostname) return null;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return SLUG.test(label) ? label : null;
}
