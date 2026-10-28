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

/**
 * Where a customer lands on an order of theirs, as after a checkout: the workspace's customer site
 * when it has one, else the web app.
 */
export function customerOrderLink(
  target: { webTemplate: string; slug: string; customerSiteOrigin: string | null },
  orderId: string,
  query = '',
): string {
  const base = target.customerSiteOrigin ?? target.webTemplate.replace('{tenant}', target.slug);
  return `${base.replace(/\/+$/, '')}/orders/${orderId}${query}`;
}

/** A page of the partner app in the web app, for one partner, as after onboarding at the payment provider. */
export function partnerPortalLink(target: { webTemplate: string; slug: string }, partnerId: string, path: string): string {
  const base = target.webTemplate.replace('{tenant}', target.slug).replace(/\/+$/, '');
  return `${base}/partner-portal/${partnerId}${path}`;
}

/**
 * The link in an identity email. Customer people go to the workspace's
 * customer site when it has one (Customers spec, goal 13); staff, and
 * customers of a workspace without a site, go to the staff app.
 */
export function identityLink(
  target: { webTemplate: string; slug: string; customerSiteOrigin: string | null; forCustomer: boolean },
  path: '/accept-invitation' | '/reset-password',
  token: string,
): string {
  if (target.forCustomer && target.customerSiteOrigin) {
    return `${target.customerSiteOrigin.replace(/\/+$/, '')}${path}#token=${encodeURIComponent(token)}`;
  }
  return webLink(target.webTemplate, target.slug, path, token);
}
