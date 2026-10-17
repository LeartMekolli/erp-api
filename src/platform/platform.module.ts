import { Module } from '@nestjs/common';
import { AuditModule } from '../modules/audit/audit.module';
import { IdentityNotifierModule } from '../modules/identity/identity-notifier';
import { TenantService } from './tenant.service';

/**
 * Tenant administration without HTTP, so the CLI and seed can use it without
 * booting access tokens or Redis. PlatformApiModule adds the endpoints.
 */
@Module({
  imports: [AuditModule, IdentityNotifierModule],
  providers: [TenantService],
  exports: [TenantService],
})
export class PlatformModule {}
