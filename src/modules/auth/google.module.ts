import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { GoogleIdentityService } from './google-identity.service';
import { GOOGLE_TOKEN_VERIFIER, GoogleTokenVerifier } from './google-token-verifier';

/**
 * Google ID token checks, shared by sign-in (Auth) and accepting a customer
 * or partner invitation (Customers, Partners), which Auth already imports.
 */
@Module({
  imports: [SettingsModule],
  providers: [{ provide: GOOGLE_TOKEN_VERIFIER, useFactory: () => new GoogleTokenVerifier() }, GoogleIdentityService],
  exports: [GoogleIdentityService],
})
export class GoogleModule {}
