import { z } from 'zod';
import { Prisma } from '../../../generated/prisma/client';
import { keySchema, percentSchema } from '../../pricing/decimals';
import { PLAN_FEATURES } from './plans';

const PRICE = /^\d{1,16}(\.\d{1,2})?$/;

/** A plan's price: above zero, at most 2 places. */
const priceSchema = z
  .string()
  .regex(PRICE, 'must be an amount above zero with at most 2 places, such as 29.00')
  .refine((value) => !PRICE.test(value) || new Prisma.Decimal(value).greaterThan(0), 'must be greater than 0');

const nameSchema = z.string().trim().min(1).max(200);

const speedsSchema = z
  .array(z.strictObject({ key: keySchema, surcharge_percent: percentSchema(0, 500).nullable() }))
  .max(50)
  .refine((speeds) => new Set(speeds.map((speed) => speed.key)).size === speeds.length, 'each speed once');

const featuresSchema = z
  .array(z.enum(PLAN_FEATURES))
  .refine((features) => new Set(features).size === features.length, 'each feature once');

const benefits = {
  name: nameSchema,
  description: z.string().trim().max(2000),
  position: z.number().int().min(0).max(1000),
  discount_percent: percentSchema(0, 100),
  monthly_credits: z.number().int().min(0).max(1_000_000),
  /** Null: unlimited. */
  member_limit: z.number().int().min(1).max(100_000).nullable(),
  features: featuresSchema,
  /** The speeds offered beyond the workspace's default speed, which every plan offers. */
  speeds: speedsSchema,
};

export const createPlanSchema = z.strictObject({
  key: keySchema,
  ...benefits,
  description: benefits.description.default(''),
  position: benefits.position.default(0),
  discount_percent: benefits.discount_percent.default('0'),
  monthly_credits: benefits.monthly_credits.default(0),
  member_limit: benefits.member_limit.default(null),
  features: featuresSchema.default([]),
  speeds: speedsSchema.default([]),
  monthly_price: priceSchema,
  yearly_price: priceSchema,
});
export type CreatePlan = z.infer<typeof createPlanSchema>;

/** Anything but the key. A new price is a new provider price; subscribers keep the one they pay. */
export const updatePlanSchema = z.strictObject({
  name: benefits.name.optional(),
  description: benefits.description.optional(),
  position: benefits.position.optional(),
  discount_percent: benefits.discount_percent.optional(),
  monthly_credits: benefits.monthly_credits.optional(),
  member_limit: benefits.member_limit.optional(),
  features: featuresSchema.optional(),
  speeds: speedsSchema.optional(),
  monthly_price: priceSchema.optional(),
  yearly_price: priceSchema.optional(),
});
export type UpdatePlan = z.infer<typeof updatePlanSchema>;

/** A plan as staff see it. Never a provider id. */
export const planResponseSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  position: z.number().int(),
  /** The free plan every customer without a subscription is on. */
  is_default: z.boolean(),
  status: z.enum(['active', 'archived']),
  currency: z.string(),
  /** Null on the free default plan. */
  monthly_price: z.string().nullable(),
  yearly_price: z.string().nullable(),
  discount_percent: z.string(),
  monthly_credits: z.number().int(),
  member_limit: z.number().int().nullable(),
  features: z.array(z.enum(PLAN_FEATURES)),
  speeds: z.array(z.strictObject({ key: z.string(), name: z.string(), surcharge_percent: z.string().nullable() })),
  /** Every current price exists at the provider, so customers can subscribe. */
  published: z.boolean(),
});
export type PlanResponse = z.infer<typeof planResponseSchema>;

export const planListResponseSchema = z.strictObject({ data: z.array(planResponseSchema) });
export type PlanListResponse = z.infer<typeof planListResponseSchema>;

export const planInclude = {
  prices: { where: { active: true } },
  speeds: { include: { deliverySpeed: { select: { key: true, name: true } } } },
} as const;

export type PlanWithPrices = Prisma.PlanGetPayload<{ include: typeof planInclude }>;

export function planResponse(row: PlanWithPrices): PlanResponse {
  const price = (interval: 'month' | 'year') => row.prices.find((candidate) => candidate.interval === interval)?.amount.toFixed(2) ?? null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    position: row.position,
    is_default: row.isDefault,
    status: row.status as PlanResponse['status'],
    currency: row.currency,
    monthly_price: price('month'),
    yearly_price: price('year'),
    discount_percent: row.discountPercent.toFixed(),
    monthly_credits: row.monthlyCredits,
    member_limit: row.memberLimit,
    features: row.features as PlanResponse['features'],
    speeds: row.speeds
      .map((speed) => ({
        key: speed.deliverySpeed.key,
        name: speed.deliverySpeed.name,
        surcharge_percent: speed.surchargePercent?.toFixed() ?? null,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    published:
      row.prices.every((candidate) => candidate.providerPriceId !== null) &&
      (row.prices.length === 0 || row.providerProductId !== null),
  };
}
