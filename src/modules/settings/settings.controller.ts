import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CurrentTenant } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { SettingKey, isSettingKey } from './setting-keys';
import { SettingsService } from './settings.service';

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

  @RequirePermission('settings.read')
  @Get()
  async list(@CurrentTenant() tenantId: string): Promise<{ data: Partial<Record<SettingKey, unknown>> }> {
    return { data: await this.prisma.inTenant(tenantId, (tx) => this.settings.list(tx)) };
  }

  @RequirePermission('settings.write')
  @Put(':key')
  set(@CurrentTenant() tenantId: string, @Param('key') key: string, @Body() value: unknown): Promise<unknown> {
    if (!isSettingKey(key)) {
      throw new BadRequestException(`Unknown setting key: ${key}`);
    }
    return this.prisma.inTenant(tenantId, (tx) => this.settings.set(tx, key, value));
  }
}
