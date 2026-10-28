/** Where credits come from (Payments 2 spec, D48). */
export const GRANT_SOURCES = ['campaign', 'staff', 'allowance', 'pack'] as const;
export type GrantSource = (typeof GRANT_SOURCES)[number];

/** Movements in `credit_entry`: grants and give-backs add, spends and expiries take away. */
export const CREDIT_ENTRY_KINDS = ['grant', 'spend', 'give_back', 'expire'] as const;
export type CreditEntryKind = (typeof CREDIT_ENTRY_KINDS)[number];

/** The spending order (D49): promotional and staff grants first, then the monthly allowance, then packs. */
export const SOURCE_ORDER: Record<GrantSource, number> = { campaign: 0, staff: 0, allowance: 1, pack: 2 };

export interface Spendable {
  id: string;
  source: GrantSource;
  grantedAt: Date;
  expiresAt: Date;
  remaining: number;
}

/** Grants in the order credits are taken from them: by source, then the earliest expiry, then the oldest. */
export function inSpendingOrder<T extends Spendable>(grants: T[]): T[] {
  return [...grants].sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      a.expiresAt.getTime() - b.expiresAt.getTime() ||
      a.grantedAt.getTime() - b.grantedAt.getTime() ||
      a.id.localeCompare(b.id),
  );
}

/**
 * How much to take from which grant to spend `amount` credits, in the spending order. Null when
 * the grants hold fewer credits than that. The caller passes only grants usable now.
 */
export function takeFrom(grants: Spendable[], amount: number): { grantId: string; amount: number }[] | null {
  const parts: { grantId: string; amount: number }[] = [];
  let left = amount;
  for (const grant of inSpendingOrder(grants)) {
    if (left === 0) break;
    if (grant.remaining <= 0) continue;
    const taken = Math.min(grant.remaining, left);
    parts.push({ grantId: grant.id, amount: taken });
    left -= taken;
  }
  return left === 0 ? parts : null;
}
