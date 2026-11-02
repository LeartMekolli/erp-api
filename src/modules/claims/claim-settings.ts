import type { Prisma } from '../../generated/prisma/client';
import type { SettingValue } from '../settings/setting-keys';
import type { SettingsService } from '../settings/settings.service';

export type ClaimSettings = SettingValue<'orders.claims'>;

/** Claims when the workspace set nothing (Orders 3 spec, "My calls"): 30 days after delivery, four reasons. */
export const DEFAULT_CLAIM_SETTINGS: ClaimSettings = {
  windowDays: 30,
  reasons: [
    { key: 'defect', name: 'Defect' },
    { key: 'wrong_size', name: 'Wrong size' },
    { key: 'damaged_in_transit', name: 'Damaged in transit' },
    { key: 'other', name: 'Other' },
  ],
};

export async function claimSettings(tx: Prisma.TransactionClient, settings: SettingsService): Promise<ClaimSettings> {
  return ((await settings.list(tx))['orders.claims'] as ClaimSettings | undefined) ?? DEFAULT_CLAIM_SETTINGS;
}

/** A reason's name; a reason since removed from the settings reads as its key. */
export function reasonNamed(key: string, settings: ClaimSettings): { key: string; name: string } {
  return { key, name: settings.reasons.find((reason) => reason.key === key)?.name ?? key };
}
