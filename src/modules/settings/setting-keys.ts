import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

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
    })
    .refine((calendar) => calendar.endHour > calendar.startHour, {
      message: 'endHour must be later than startHour',
      path: ['endHour'],
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
