import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformTenantsController } from './platform-tenants.controller';
import { PlatformModule } from './platform.module';

/** The platform surface over HTTP: `/platform/...` (spec 3.2). */
@Module({
  imports: [PlatformModule, IdentityModule],
  controllers: [PlatformAuthController, PlatformTenantsController],
  providers: [PlatformAuthService],
})
export class PlatformApiModule {}
