import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { ApiDoc } from '../docs/api-doc';
import { Public } from '../modules/identity/route-markers';
import { PlatformAuthService } from './platform-auth.service';
import type { PlatformSession } from './platform-auth.service';

// The email is not format-checked: a malformed one must fail like an unknown one.
const loginSchema = z.object({
  email: z.string().max(320),
  password: z.string().min(1).max(128),
});

@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @ApiDoc({
    summary: 'Platform admin login.',
    description:
      'Answers a 15-minute platform access token and its expiry, with no refresh token. Use it in Authorize for the ' +
      '`/platform` routes; tenant routes do not accept it.',
    body: loginSchema,
    errors: [400, 401],
  })
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>): Promise<PlatformSession> {
    return this.auth.login(body.email, body.password);
  }
}
