import { Module } from '@nestjs/common';
import { RateLimitModule } from '../../common/rate-limit/rate-limiter';
import { AuditModule } from '../audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { AuthController } from './auth.controller';
import { SessionService } from './session.service';

@Module({
  imports: [IdentityModule, AuditModule, RateLimitModule],
  controllers: [AuthController],
  providers: [SessionService],
})
export class AuthModule {}
