import { Body, Controller, Headers, HttpCode, Ip, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ConfigService } from '../../config/config.service';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { passwordSchema } from '../identity/passwords';
import { Authenticated, Public } from '../identity/route-markers';
import { InvitationAcceptService } from './invitation-accept.service';
import { PasswordResetService } from './password-reset.service';
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

const acceptInvitationSchema = z.object({
  token: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  password: passwordSchema,
});

// As with login, the email is not format-checked: every request looks alike.
const resetRequestSchema = z.object({
  email: z.string().max(320),
  workspace: z.string().max(63).optional(),
});

const resetConfirmSchema = z.object({
  token: z.string().min(1).max(200),
  password: passwordSchema,
});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionService,
    private readonly invitations: InvitationAcceptService,
    private readonly passwordResets: PasswordResetService,
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

  @Public()
  @Post('invitations/accept')
  @HttpCode(204)
  async acceptInvitation(
    @Body(new ZodValidationPipe(acceptInvitationSchema)) body: z.infer<typeof acceptInvitationSchema>,
  ): Promise<void> {
    await this.invitations.accept(body.token, body.name, body.password);
  }

  /** Always 202, whether or not the email belongs to anyone. */
  @Public()
  @Post('password-reset')
  @HttpCode(202)
  async requestPasswordReset(
    @Body(new ZodValidationPipe(resetRequestSchema)) body: z.infer<typeof resetRequestSchema>,
    @Headers('host') host: string | undefined,
    @Ip() ip: string,
  ): Promise<void> {
    const slug = resolveTenantSlug(host, body.workspace, this.config.get('APP_BASE_DOMAIN'));
    await this.passwordResets.request(slug, body.email, ip);
  }

  @Public()
  @Post('password-reset/confirm')
  @HttpCode(204)
  async confirmPasswordReset(
    @Body(new ZodValidationPipe(resetConfirmSchema)) body: z.infer<typeof resetConfirmSchema>,
  ): Promise<void> {
    await this.passwordResets.confirm(body.token, body.password);
  }
}
