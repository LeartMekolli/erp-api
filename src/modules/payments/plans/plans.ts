import { Prisma } from '../../../generated/prisma/client';

/**
 * The switches a plan turns on (Payments 2 spec, goal 1). Code checks them, so they are code; each
 * plan's choice of them is data. The `ai_*` switches turn on the customer AI tools (AI 2 spec, goal 1).
 */
export const PLAN_FEATURES = ['progress_emails', 'pay_later', 'ai_recommendations', 'ai_marketing', 'ai_brand', 'ai_images'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export const PLAN_INTERVALS = ['month', 'year'] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];

export interface PriceTerms {
  amount: Prisma.Decimal;
  interval: PlanInterval;
}

/** What a price costs per month: a yearly price ÷ 12, not rounded. */
export function monthlyEquivalent(price: PriceTerms): Prisma.Decimal {
  return price.interval === 'year' ? price.amount.div(12) : price.amount;
}

/** Moving from `current` to `next` takes effect at once when it costs as much or more per month (spec B3). */
export function isUpgrade(current: PriceTerms, next: PriceTerms): boolean {
  return monthlyEquivalent(next).greaterThanOrEqualTo(monthlyEquivalent(current));
}
