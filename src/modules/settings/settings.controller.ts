import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { SETTING_KEYS, SettingKey, isSettingKey } from './setting-keys';
import { SettingsService } from './settings.service';

/** For the docs only: the value is checked against its own key's schema. */
const anySettingValueSchema = z.union(Object.values(SETTING_KEYS));

/**
 * Spec 3.3. The body of a PUT is the value itself; it is validated against the
 * key's schema inside SettingsService before anything is written (D58).
 */
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  @ApiDoc({
    summary: "The tenant's settings that have been set, by key.",
    description: 'Answers `data`: an object from setting key to value.',
    errors: [401, 403],
  })
  @RequirePermission('settings.read')
  @Get()
  async list(@CurrentTenant() tenantId: string): Promise<{ data: Partial<Record<SettingKey, unknown>> }> {
    return { data: await this.prisma.inTenant(tenantId, (tx) => this.settings.list(tx)) };
  }

  @ApiDoc({
    summary: 'Set one setting. The body is the value itself.',
    description:
      `Keys: ${Object.keys(SETTING_KEYS).map((key) => `\`${key}\``).join(', ')}. ` +
      'The value is checked against the schema of its key; the body schema shows the shapes of all keys. ' +
      'Answers the stored value. An unknown key is a 400.',
    body: anySettingValueSchema,
    errors: [400, 401, 403],
  })
  @RequirePermission('settings.write')
  @Put(':key')
  set(@CurrentTenant() tenantId: string, @Param('key') key: string, @Body() value: unknown): Promise<unknown> {
    if (!isSettingKey(key)) {
      throw new BadRequestException(`Unknown setting key: ${key}`);
    }
    return this.prisma.inTenant(tenantId, (tx) => this.settings.set(tx, key, value));
  }
}
