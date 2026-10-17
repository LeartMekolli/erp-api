import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '../../config/config.service';
import { ACCESS_TOKEN_SECONDS, AccessTokenService } from './access-token.service';
import { AuthGuard } from './auth.guard';

const AUDIENCE = 'erp-api';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: { algorithm: 'HS256', audience: AUDIENCE, expiresIn: ACCESS_TOKEN_SECONDS },
        verifyOptions: { algorithms: ['HS256'], audience: AUDIENCE },
      }),
    }),
  ],
  providers: [AccessTokenService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AccessTokenService],
})
export class IdentityModule {}
