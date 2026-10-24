import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import type { ApiDocOptions } from '../../docs/api-doc';
import { CurrentPartner, CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { PartnerAuth, TenantAuth } from '../identity/auth-context';
import { PartnerAccess, RequirePermission } from '../identity/route-markers';
import { stepPriceResponseSchema } from '../pricing/pricing-response';
import type { StepPriceResponse } from '../pricing/pricing-response';
import { stepPriceSchema } from '../pricing/step-prices.service';
import { PartnerPricesService } from './partner-prices.service';
import { partnerPricesResponseSchema } from './partner-response';
import type { PartnerPricesResponse } from './partner-response';

const idParam = new ZodValidationPipe(z.uuid());

// The same docs for staff and the partner's own people; only the access differs.
const LIST: ApiDocOptions = {
  summary: "The partner's price list, in step type order, each step's default first.",
  response: partnerPricesResponseSchema,
  errors: [400, 404],
};
const PUT: ApiDocOptions = {
  summary: "Set the partner's price for a step, for one material or as the step's default.",
  description:
    "The same blocks and checks as the workspace's step prices. A step type nobody prices, such as final QC, is a 400; " +
    'an unknown step type or material is a 404.',
  body: stepPriceSchema,
  response: stepPriceResponseSchema,
  errors: [400, 404],
};
const COPY: ApiDocOptions = {
  summary: "Copy the workspace's prices for the partner's priced capabilities that it hasn't priced yet.",
  description: 'Prices the partner already has are kept, so copying again adds nothing. Answers the whole list.',
  response: partnerPricesResponseSchema,
  errors: [400, 404],
};

/** Staff keep a partner's price list on its behalf (Partners spec, goal 8). */
@Controller('partners/:id')
export class PartnerPricesController {
  constructor(private readonly prices: PartnerPricesService) {}

  @ApiDoc(LIST)
  @RequirePermission('partner.read')
  @Get('prices')
  list(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<PartnerPricesResponse> {
    return this.prices.list(tenantId, id);
  }

  @ApiDoc(PUT)
  @RequirePermission('partner.write')
  @Put('step-types/:stepTypeId/prices')
  put(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Param('stepTypeId', idParam) stepTypeId: string,
    @Body(new ZodValidationPipe(stepPriceSchema)) body: z.infer<typeof stepPriceSchema>,
  ): Promise<StepPriceResponse> {
    return this.prices.put(auth, id, stepTypeId, body);
  }

  @ApiDoc(COPY)
  @RequirePermission('partner.write')
  @Post('prices/copy-from-workspace')
  @HttpCode(200)
  copy(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<PartnerPricesResponse> {
    return this.prices.copyFromWorkspace(auth, id);
  }
}

/** A partner's owner and admins keep its own price list (Partners spec, goal 8). */
@Controller('partner-portal/partners/:partnerId')
export class PortalPricesController {
  constructor(private readonly prices: PartnerPricesService) {}

  @ApiDoc(LIST)
  @PartnerAccess('member')
  @Get('prices')
  list(@CurrentPartner() partner: PartnerAuth): Promise<PartnerPricesResponse> {
    return this.prices.list(partner.tenantId, partner.partnerId);
  }

  @ApiDoc(PUT)
  @PartnerAccess('admin')
  @Put('step-types/:stepTypeId/prices')
  put(
    @CurrentPartner() partner: PartnerAuth,
    @Param('stepTypeId', idParam) stepTypeId: string,
    @Body(new ZodValidationPipe(stepPriceSchema)) body: z.infer<typeof stepPriceSchema>,
  ): Promise<StepPriceResponse> {
    return this.prices.put(partner, partner.partnerId, stepTypeId, body);
  }

  @ApiDoc(COPY)
  @PartnerAccess('admin')
  @Post('prices/copy-from-workspace')
  @HttpCode(200)
  copy(@CurrentPartner() partner: PartnerAuth): Promise<PartnerPricesResponse> {
    return this.prices.copyFromWorkspace(partner, partner.partnerId);
  }
}
