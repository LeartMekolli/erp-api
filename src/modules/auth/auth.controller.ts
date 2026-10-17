import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ConfigService } from '../../config/config.service';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { Authenticated, Public } from '../identity/route-markers';
import { SessionService } from './session.service';
import type { SessionTokens } from './session.service';
import { resolveTenantSlug } from './tenant-resolver';

// The email is not format-checked: a malformed one must fail like an unknown one.
const loginSchema = z.object({
  email: z.string().max(320),
  password: z.string().min(1).max(128),
  workspace: z.string().max(63).optional(),
});

const refreshTokenSchema = z.object({ refresh_token: z.string().min(1).max(200) });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Headers('host') host: string | undefined,
  ): Promise<SessionTokens> {
    const slug = resolveTenantSlug(host, body.workspace, this.config.get('APP_BASE_DOMAIN'));
    return this.sessions.login(slug, body.email, body.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodValidationPipe(refreshTokenSchema)) body: z.infer<typeof refreshTokenSchema>): Promise<SessionTokens> {
    return this.sessions.refresh(body.refresh_token);
  }

  @Authenticated()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(refreshTokenSchema)) body: z.infer<typeof refreshTokenSchema>,
  ): Promise<void> {
    await this.sessions.logout(auth, body.refresh_token);
  }
}
