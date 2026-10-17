import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { newId } from '../../common/ids/uuid';
import type { Prisma } from '../../generated/prisma/client';
import { SETTING_KEYS, SettingKey, SettingValue, isSettingKey, parseSetting } from './setting-keys';

/**
 * Typed access to tenant settings. Every method takes the caller's `inTenant`
 * transaction, so a settings change can be part of a larger atomic operation
 * and row-level security decides which tenant's settings are visible.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  /**
   * Every stored setting that is still a known key with a valid value. One
   * that no longer validates is left out and logged, so a single stale value
   * does not break the whole settings page.
   */
  async list(tx: Prisma.TransactionClient): Promise<Partial<Record<SettingKey, unknown>>> {
    const rows = await tx.tenantSetting.findMany({ orderBy: { key: 'asc' } });
    const settings: Partial<Record<SettingKey, unknown>> = {};

    for (const row of rows) {
      if (!isSettingKey(row.key)) {
        this.logger.warn(`Ignoring unknown setting key ${row.key}`);
        continue;
      }
      const parsed = SETTING_KEYS[row.key].safeParse(row.value);
      if (!parsed.success) {
        this.logger.warn(`Ignoring setting ${row.key}: stored value no longer validates`);
        continue;
      }
      settings[row.key] = parsed.data;
    }

    return settings;
  }

  /** Re-validates on read, so a value stored under an older schema fails loudly. */
  async get<K extends SettingKey>(tx: Prisma.TransactionClient, key: K): Promise<SettingValue<K>> {
    const row = await tx.tenantSetting.findFirst({ where: { key } });

    if (!row) {
      throw new NotFoundException(`Setting ${key} is not set`);
    }

    return parseSetting(key, row.value);
  }

  /**
   * One atomic upsert on (tenant_id, key): two concurrent writes cannot both
   * try to insert. Raw SQL because Prisma's upsert needs the tenant id in its
   * unique key, and here only the column default knows it. The id and
   * updated_at are set explicitly because their defaults live in Prisma Client,
   * not in the database.
   */
  async set<K extends SettingKey>(
    tx: Prisma.TransactionClient,
    key: K,
    value: unknown,
  ): Promise<SettingValue<K>> {
    const parsed = parseSetting(key, value);

    await tx.$executeRaw`
      INSERT INTO tenant_setting (id, key, value, updated_at)
      VALUES (${newId()}::uuid, ${key}, ${JSON.stringify(parsed)}::jsonb, now())
      ON CONFLICT (tenant_id, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;

    return parsed;
  }
}
