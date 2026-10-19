/**
 * A link into the web app for a tenant (plan N8). The token goes in the
 * fragment, which browsers never send to a server, so it cannot end up in a
 * server log or a Referer header.
 */
export function webLink(
  template: string,
  slug: string,
  path: '/accept-invitation' | '/reset-password',
  token: string,
): string {
  const base = template.replace('{tenant}', slug).replace(/\/+$/, '');
  return `${base}${path}#token=${encodeURIComponent(token)}`;
}
