import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { ApiDoc } from '../docs/api-doc';
import { sessionTokensSchema } from '../modules/auth/session.service';
import type { SessionTokens } from '../modules/auth/session.service';
import { CurrentPlatformAdmin } from '../modules/identity/auth-context';
import type { PlatformAuth } from '../modules/identity/auth-context';
import { Authenticated, Public } from '../modules/identity/route-markers';
import { PlatformAuthService } from './platform-auth.service';

// The email is not format-checked: a malformed one must fail like an unknown one.
const loginSchema = z.object({
  email: z.string().max(320),
  password: z.string().min(1).max(128),
});

const refreshTokenSchema = z.object({ refresh_token: z.string().min(1).max(200) });

@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @ApiDoc({
    summary: 'Platform admin login.',
    description:
      'Answers a 15-minute platform access token and a refresh token; the session ends 12 hours after login, ' +
      'however often it is refreshed. Use the access token in Authorize for the `/platform` routes; tenant routes ' +
      'do not accept it.',
    body: loginSchema,
    response: sessionTokensSchema,
    errors: [400, 401],
  })
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>): Promise<SessionTokens> {
    return this.auth.login(body.email, body.password);
  }

  @ApiDoc({
    summary: 'Swap a platform refresh token for a new access and refresh token.',
    description:
      'Each refresh token works once. Reusing one revokes the whole session; a session 12 hours old is over, so log in again.',
    body: refreshTokenSchema,
    response: sessionTokensSchema,
    errors: [400, 401],
  })
  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodValidationPipe(refreshTokenSchema)) body: z.infer<typeof refreshTokenSchema>): Promise<SessionTokens> {
    return this.auth.refresh(body.refresh_token);
  }

  @ApiDoc({
    summary: 'Platform admin logout: revoke the refresh token and the access token in use.',
    body: refreshTokenSchema,
    errors: [400, 401, 403],
  })
  @Authenticated()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentPlatformAdmin() admin: PlatformAuth,
    @Body(new ZodValidationPipe(refreshTokenSchema)) body: z.infer<typeof refreshTokenSchema>,
  ): Promise<void> {
    await this.auth.logout(admin, body.refresh_token);
  }
}
