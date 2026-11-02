import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../../identity/auth-context';
import type { TenantAuth } from '../../identity/auth-context';
import { RequirePermission } from '../../identity/route-markers';
import { customerPriorityResponseSchema } from './priority-response';
import type { CustomerPriorityResponse } from './priority-response';
import { PriorityService, priorityOverrideSchema } from './priority.service';
import type { PriorityOverrideInput } from './priority.service';

const idParam = new ZodValidationPipe(z.uuid());

/** A customer's priority score and band, for staff only (Customers 2 spec, goals 14–16). */
@Controller('customers/:id/priority')
export class PriorityController {
  constructor(private readonly priority: PriorityService) {}

  @ApiDoc({
    summary: "The customer's priority score, its four parts, the computed band, any override and the band in force.",
    description: 'Computed nightly against the workspace\'s other customers. A customer never computed reads score 0 and the default band.',
    response: customerPriorityResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('customer.read')
  @Get()
  get(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<CustomerPriorityResponse> {
    return this.priority.get(tenantId, id);
  }

  @ApiDoc({
    summary: "Recompute every customer's priority score now and answer this customer's.",
    description: 'A score ranks the customer against the others, so the whole workspace is computed.',
    response: customerPriorityResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('settings.write')
  @HttpCode(200)
  @Post('refresh')
  refresh(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<CustomerPriorityResponse> {
    return this.priority.refreshFor(tenantId, id);
  }

  @ApiDoc({
    summary: 'Put the customer in a band through a date, with a reason, whatever its score.',
    description:
      'The override is in force through `ends_on` in the workspace\'s zone; the computed band is back the day after. ' +
      'A band that is not in `customers.priority`, or an end date in the past, is a 400. Audited.',
    body: priorityOverrideSchema,
    response: customerPriorityResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('settings.write')
  @Put('override')
  setOverride(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(priorityOverrideSchema)) body: PriorityOverrideInput,
  ): Promise<CustomerPriorityResponse> {
    return this.priority.setOverride(auth, id, body);
  }

  @ApiDoc({
    summary: "Remove the customer's band override; the computed band is in force at once.",
    description: 'Audited. Removing an override the customer doesn\'t have changes nothing.',
    errors: [400, 404],
  })
  @RequirePermission('settings.write')
  @HttpCode(204)
  @Delete('override')
  removeOverride(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<void> {
    return this.priority.removeOverride(auth, id);
  }
}
