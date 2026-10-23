import { Body, Controller, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { customerSiteResponseSchema } from './customer-response';
import type { CustomerSiteResponse } from './customer-response';
import { CustomerSiteService, customerSiteSchema } from './customer-site.service';

/** The workspace's customer site (Customers spec, goal 13). */
@Controller('workspace/customer-site')
export class CustomerSiteController {
  constructor(private readonly site: CustomerSiteService) {}

  @ApiDoc({
    summary: "Set or clear the workspace's customer site, such as https://shop.example.",
    description:
      'Customer invitation and password reset emails link there, and the site may call the API from the browser. ' +
      'Other API instances pick up a change within a minute.',
    body: customerSiteSchema,
    response: customerSiteResponseSchema,
    errors: [400],
  })
  @RequirePermission('settings.write')
  @Put()
  set(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(customerSiteSchema)) body: z.infer<typeof customerSiteSchema>,
  ): Promise<CustomerSiteResponse> {
    return this.site.set(auth, body.origin);
  }
}
