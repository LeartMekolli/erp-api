import { Controller, Post } from '@nestjs/common';
import { ApiDoc } from '../docs/api-doc';
import { RequirePermission } from '../modules/identity/route-markers';

/**
 * Proves the error path end to end: the response is a 500, the log has the
 * stack, and the error reaches Sentry. Never a feature; platform admins only.
 */
@Controller('platform/diagnostics')
export class PlatformDiagnosticsController {
  @ApiDoc({
    summary: 'Fail on purpose with a 500, to check that errors reach logs and error reporting.',
    description: 'Never answers successfully.',
    errors: [401, 403],
  })
  @RequirePermission('platform.diagnostics')
  @Post('error')
  fail(): never {
    throw new Error('Deliberate diagnostics error');
  }
}
