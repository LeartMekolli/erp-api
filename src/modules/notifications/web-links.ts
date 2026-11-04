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

/** How a customer comes back from the payment provider: paid, gave up, or back from its billing portal. */
export type PaymentOutcome = 'paid' | 'cancelled' | 'back';

/** Where a customer comes back to from the payment provider: their customer site, or the API's own page. */
export interface CustomerReturnTarget {
  apiUrl: string;
  customerSiteOrigin: string | null;
}

/**
 * The API's page for a customer back from the payment provider when the workspace has no customer
 * site. The web app is the staff app, never a customer's.
 */
function paymentReturnLink(apiUrl: string, outcome: PaymentOutcome): string {
  return `${apiUrl.replace(/\/+$/, '')}/payment-return?outcome=${outcome}`;
}

/** Where a customer lands on an order of theirs after a checkout. */
export function customerOrderLink(target: CustomerReturnTarget, orderId: string, outcome: 'paid' | 'cancelled'): string {
  if (!target.customerSiteOrigin) return paymentReturnLink(target.apiUrl, outcome);
  const query = outcome === 'paid' ? '?payment=success' : '?payment=cancelled';
  return `${target.customerSiteOrigin.replace(/\/+$/, '')}/orders/${orderId}${query}`;
}

/** The customer's billing page, as after a subscription's or a pack's checkout, or the provider's billing portal. */
export function customerBillingLink(target: CustomerReturnTarget, outcome: PaymentOutcome, query = ''): string {
  if (!target.customerSiteOrigin) return paymentReturnLink(target.apiUrl, outcome);
  return `${target.customerSiteOrigin.replace(/\/+$/, '')}/billing${query}`;
}

/** A page of the partner app in the web app, for one partner, as after onboarding at the payment provider. */
export function partnerPortalLink(target: { webTemplate: string; slug: string }, partnerId: string, path: string): string {
  const base = target.webTemplate.replace('{tenant}', target.slug).replace(/\/+$/, '');
  return `${base}/partner-portal/${partnerId}${path}`;
}

/**
 * The link in an identity email. Customer people go to the workspace's
 * customer site (Customers spec, goal 13), staff to the staff app. A customer
 * of a workspace without a site has no link: the staff app is not theirs, so
 * the email is not sent.
 */
export function identityLink(
  target: { webTemplate: string; slug: string; customerSiteOrigin: string | null; forCustomer: boolean },
  path: '/accept-invitation' | '/reset-password',
  token: string,
): string | null {
  if (target.forCustomer) {
    return target.customerSiteOrigin
      ? `${target.customerSiteOrigin.replace(/\/+$/, '')}${path}#token=${encodeURIComponent(token)}`
      : null;
  }
  return webLink(target.webTemplate, target.slug, path, token);
}
