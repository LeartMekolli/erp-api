import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { checkResponseSchema } from './check-response';
import type { CheckResponse } from './check-response';
import { CheckService, checkRequestSchema } from './check.service';

const idSchema = z.uuid();

/** The configuration check (Catalog spec, "Configuration check"). */
@Controller('catalog/products')
export class CheckController {
  constructor(private readonly checks: CheckService) {}

  @ApiDoc({
    summary: 'Check a configuration of a product: accepted with its scaled measures and material price, or refused.',
    description:
      'Unchosen groups take their default, then the option rules run. `size` is `{ "scale": "1.5" }` for a range or ' +
      '`{ "named": "M" }`; without it the design is used as it is. A custom product needs the customer\'s ' +
      '`file_version_id`; a ready-made one uses its own file. Breaking a rule, a size out of range, an unmeasured ' +
      'file or a missing price is a 200 with `accepted: false` and every reason; only malformed input is a 400. ' +
      'Nothing is stored.',
    body: checkRequestSchema,
    response: checkResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('catalog.read')
  @Post(':id/check')
  @HttpCode(200)
  check(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(checkRequestSchema)) body: z.infer<typeof checkRequestSchema>,
  ): Promise<CheckResponse> {
    return this.checks.check(tenantId, id, body);
  }
}
