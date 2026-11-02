import type { Prisma } from '../../../generated/prisma/client';
import { localDate } from '../../orders/dates';
import type { SettingValue } from '../../settings/setting-keys';
import type { SettingsService } from '../../settings/settings.service';

export type PrioritySettings = SettingValue<'customers.priority'>;

/** Used until the workspace sets `customers.priority`: every part counts the same, and no bands. */
export const DEFAULT_PRIORITY_SETTINGS: PrioritySettings = {
  weights: { lifetime: 1, recent: 1, frequency: 1, payment: 1 },
  defaultBand: { key: 'standard', name: 'Standard' },
  bands: [],
};

/** The workspace's date at `at`, in its own zone. */
export async function workspaceToday(tx: Prisma.TransactionClient, at: Date): Promise<{ today: string; timezone: string }> {
  const [{ timezone }] = await tx.$queryRaw<{ timezone: string }[]>`
    SELECT timezone FROM tenant WHERE id = current_setting('app.current_tenant_id')::uuid`;
  return { today: localDate(at, timezone), timezone };
}

export async function prioritySettings(tx: Prisma.TransactionClient, settings: SettingsService): Promise<PrioritySettings> {
  return ((await settings.list(tx))['customers.priority'] as PrioritySettings | undefined) ?? DEFAULT_PRIORITY_SETTINGS;
}

/** What decides a customer's band: its `customer_priority` row, if it has one. */
export interface PriorityRow {
  bandKey: string | null;
  overrideBandKey: string | null;
  overrideEndsOn: Date | null;
}

export interface Band {
  key: string;
  name: string;
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const dateOf = (day: string) => new Date(`${day}T00:00:00Z`);

/** An override counts through its last day, in the workspace's zone. */
export function overrideInForce(row: PriorityRow | null, today: string): boolean {
  return row?.overrideBandKey != null && row.overrideEndsOn !== null && dayOf(row.overrideEndsOn) >= today;
}

/** A band of the settings by key; a key no longer there, or null, is the default band. */
export function bandNamed(key: string | null, settings: PrioritySettings): Band {
  const band = key === null ? undefined : settings.bands.find((one) => one.key === key);
  return band ? { key: band.key, name: band.name } : { key: settings.defaultBand.key, name: settings.defaultBand.name };
}

/**
 * The band in force (spec, "My calls"): the override through its end date, else the computed band. Worked
 * out when read, so an override expires without anything running.
 */
export function bandInForce(row: PriorityRow | null, today: string, settings: PrioritySettings): Band & { overridden: boolean } {
  const overridden = overrideInForce(row, today);
  return { ...bandNamed(overridden ? row!.overrideBandKey : (row?.bandKey ?? null), settings), overridden };
}

/** The customers whose band in force is the configured band `key`. */
function inBand(key: string, today: string): Prisma.CustomerWhereInput {
  return {
    priority: {
      is: {
        OR: [
          { overrideBandKey: key, overrideEndsOn: { gte: dateOf(today) } },
          { bandKey: key, OR: [{ overrideEndsOn: null }, { overrideEndsOn: { lt: dateOf(today) } }] },
        ],
      },
    },
  };
}

/**
 * The customers whose band in force is `key`: one of the bands, or the default band, which holds everyone
 * else. The default band is written out rather than as NOT(any band): with SQL's nulls, NOT over a null band
 * key is null, not true, and would leave those customers out.
 */
export function bandWhere(key: string, today: string, settings: PrioritySettings): Prisma.CustomerWhereInput {
  if (key !== settings.defaultBand.key) return inBand(key, today);
  const keys = settings.bands.map((band) => band.key);
  return {
    OR: [
      { priority: { is: null } },
      {
        priority: {
          is: {
            OR: [
              // An override in force, to a band no longer configured.
              { overrideEndsOn: { gte: dateOf(today) }, overrideBandKey: { notIn: keys } },
              // No override in force, and a computed band that is the default or no longer configured.
              {
                OR: [{ overrideEndsOn: null }, { overrideEndsOn: { lt: dateOf(today) } }],
                AND: [{ OR: [{ bandKey: null }, { bandKey: { notIn: keys } }] }],
              },
            ],
          },
        },
      },
    ],
  };
}

export function isBandKey(key: string, settings: PrioritySettings): boolean {
  return key === settings.defaultBand.key || settings.bands.some((band) => band.key === key);
}
