import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { keySchema } from '../pricing/decimals';

/** One monthly export schedule: on or off, and the staff told when its files are ready. */
const reportSchedule = z.object({ enabled: z.boolean(), recipientUserIds: z.array(z.uuid()).max(20) });

/**
 * Every tenant setting the system knows, each with the schema its value must
 * satisfy. A key that is not listed here cannot be stored, so settings never
 * grow into an untyped bag of strings.
 *
 * Responses pass through StripCredentialsInterceptor, which drops any field
 * named `*hash`, `*password` or `*secret`. A value with such a field is stored
 * but never read back through GET /settings; that suits secrets, which should
 * be write-only, but name ordinary fields accordingly.
 */
export const SETTING_KEYS = {
  'notification.sender': z.object({
    name: z.string().min(1),
    email: z.email(),
  }),
  'notification.staffRecipients': z.object({
    byEvent: z.record(z.string(), z.array(z.email())),
  }),
  'business.calendar': z
    .object({
      // ISO weekdays: 1 is Monday, 7 is Sunday.
      workingDays: z.array(z.number().int().min(1).max(7)).min(1),
      startHour: z.number().int().min(0).max(23),
      endHour: z.number().int().min(1).max(24),
      // Days the workspace is closed, such as public holidays; promised dates skip them (Orders spec, B1).
      closedDates: z.array(z.iso.date()).max(366).default([]),
    })
    .refine((calendar) => calendar.endHour > calendar.startHour, {
      message: 'endHour must be later than startHour',
      path: ['endHour'],
    }),
  // How jobs reach partners (Partners spec, goals 10 and P4): how long an offer stays open, and
  // whether the lines of one order may go to different partners (enforced by Orders).
  'partners.routing': z.object({
    offerHours: z.number().int().min(1).max(720),
    splitOrderLines: z.boolean(),
  }),
  // How far ahead of an order's promised date a partner's job is due, in working days (Orders spec, B3): a
  // buffer for every job, and one more allowance for a part of an assembly. Unset: 2 and 1.
  'orders.scheduling': z.object({
    bufferDays: z.number().int().min(0).max(60),
    assemblyAllowanceDays: z.number().int().min(0).max(60),
  }),
  // How much each part counts towards a partner's overall score (Partners spec, goal 15).
  'partners.scoreWeights': z.object({
    quality: z.number().int().min(0).max(10),
    scrap: z.number().int().min(0).max(10),
    reliability: z.number().int().min(0).max(10),
    onTime: z.number().int().min(0).max(10),
    rating: z.number().int().min(0).max(10),
    // Pieces claimed at the partner's fault (Orders 3 spec, goal 6); 2 when left out.
    claims: z.number().int().min(0).max(10).optional(),
  }),
  // Claims after delivery (Orders 3 spec, goal 1): within how many days of delivery, and the reasons a
  // claim may give. Unset: DEFAULT_CLAIM_SETTINGS in src/modules/claims/claim-settings.ts.
  'orders.claims': z.object({
    windowDays: z.number().int().min(1).max(365),
    reasons: z
      .array(z.object({ key: keySchema, name: z.string().trim().min(1).max(100) }))
      .min(1)
      .max(20)
      .refine((reasons) => new Set(reasons.map((reason) => reason.key)).size === reasons.length, { message: 'reason keys must be unique' }),
  }),
  // Exports made on the workspace's 1st for last month, and who is told (Orders 3 spec, goal 10): the
  // accountant's files and top customers. Unset: both off.
  'reports.schedules': z.object({
    accounting: reportSchedule,
    top_customers: reportSchedule,
  }),
  // How a pay-first order is paid (Payments spec): within how many hours, and where the checkout
  // returns to. Unset: 24 hours, and the customer site's order page.
  'payments.collection': z.object({
    payWithinHours: z.number().int().min(1).max(24).default(24),
    checkoutSuccessUrl: z.url().optional(),
    checkoutCancelUrl: z.url().optional(),
  }),
  // Credits per use of each customer AI tool (AI 2 spec, goal 2); a refinement costs an image. Unset:
  // DEFAULT_TOOL_PRICES in src/modules/ai/customer-tools/customer-tools.ts.
  'ai.toolPrices': z.object({
    recommendations: z.number().int().min(1).max(1000),
    marketing: z.number().int().min(1).max(1000),
    brand_content: z.number().int().min(1).max(1000),
    image: z.number().int().min(1).max(1000),
  }),
  // Customers' priority score (Customers 2 spec, goals 11–17): how much each part counts, the band of a
  // customer below every threshold, and the bands with the score each starts at and what they unlock.
  // Unset: DEFAULT_PRIORITY_SETTINGS in src/modules/customers/priority/bands.ts.
  'customers.priority': z
    .object({
      weights: z.object({
        lifetime: z.number().int().min(0).max(10),
        recent: z.number().int().min(0).max(10),
        frequency: z.number().int().min(0).max(10),
        payment: z.number().int().min(0).max(10),
      }),
      defaultBand: z.object({ key: keySchema, name: z.string().trim().min(1).max(100) }),
      bands: z
        .array(
          z.object({
            key: keySchema,
            name: z.string().trim().min(1).max(100),
            from: z.number().int().min(1).max(100),
            firstInLine: z.boolean(),
            mayPickPartner: z.boolean(),
          }),
        )
        .max(10),
    })
    .superRefine((value, ctx) => {
      const keys = new Set<string>([value.defaultBand.key]);
      const starts = new Set<number>();
      value.bands.forEach((band, index) => {
        if (keys.has(band.key)) ctx.addIssue({ code: 'custom', message: 'band keys must be unique and differ from the default band', path: ['bands', index, 'key'] });
        if (starts.has(band.from)) ctx.addIssue({ code: 'custom', message: 'two bands cannot start at the same score', path: ['bands', index, 'from'] });
        keys.add(band.key);
        starts.add(band.from);
      });
    }),
  // The workspace's own Google OAuth client ids; Sign in with Google is off without it.
  'auth.google': z.object({
    clientIds: z.array(z.string().min(1).max(200)).min(1).max(5),
  }),
} as const;

export type SettingKey = keyof typeof SETTING_KEYS;

export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_KEYS)[K]>;

/** Own properties only: `toString` and friends are not setting keys. */
export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_KEYS, key);
}

/**
 * Throws a ZodError for an invalid value, which the error filter renders as a
 * 400 listing every failing field.
 */
export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  if (!isSettingKey(key)) {
    throw new BadRequestException(`Unknown setting key: ${String(key)}`);
  }

  return SETTING_KEYS[key].parse(value) as SettingValue<K>;
}
