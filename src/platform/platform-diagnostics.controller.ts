import { Controller, Post } from '@nestjs/common';
import { RequirePermission } from '../modules/identity/route-markers';

/**
 * Proves the error path end to end: the response is a 500, the log has the
 * stack, and the error reaches Sentry. Never a feature; platform admins only.
 */
@Controller('platform/diagnostics')
export class PlatformDiagnosticsController {
  @RequirePermission('platform.diagnostics')
  @Post('error')
  fail(): never {
    throw new Error('Deliberate diagnostics error');
  }
}
