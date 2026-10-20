import { Module } from '@nestjs/common';
import { PlatformJobsController } from '../jobs/platform-jobs.controller';
import { IdentityModule } from '../modules/identity/identity.module';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformDiagnosticsController } from './platform-diagnostics.controller';
import { PlatformTenantsController } from './platform-tenants.controller';
import { PlatformModule } from './platform.module';

/** The platform surface over HTTP: `/platform/...` (spec 3.2). */
@Module({
  imports: [PlatformModule, IdentityModule],
  controllers: [
    PlatformAuthController,
    PlatformTenantsController,
    PlatformJobsController,
    PlatformDiagnosticsController,
  ],
  providers: [PlatformAuthService],
})
export class PlatformApiModule {}
