/**
 * Which tenant a login (or password reset) is for, before any token exists
 * (F5). The subdomain wins: `acme.<baseDomain>` is tenant `acme`. Without a
 * tenant subdomain, the `workspace` field from the body is used. After login
 * the tenant comes from the token only (ADR 0001).
 *
 * Only a single label directly under the base domain counts; `www` and nested
 * subdomains are not tenants.
 */
export function resolveTenantSlug(
  host: string | undefined,
  workspace: string | undefined,
  baseDomain: string,
): string | undefined {
  const hostname = host?.split(':')[0]?.toLowerCase();
  const suffix = `.${baseDomain.toLowerCase()}`;

  if (hostname?.endsWith(suffix)) {
    const label = hostname.slice(0, -suffix.length);
    if (label && !label.includes('.') && label !== 'www') {
      return label;
    }
  }

  const fallback = workspace?.trim().toLowerCase();
  return fallback ? fallback : undefined;
}
