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
import { partnerPricesResponseSchema, portalPricesResponseSchema } from './partner-response';
import type { PartnerPricesResponse, PortalPricesResponse } from './partner-response';

const idParam = new ZodValidationPipe(z.uuid());

const LIST: ApiDocOptions = {
  summary: "The partner's price list, in step type order, each step's default first.",
  description: '`copied_from_workspace` marks prices still at the workspace numbers staff copied, which the partner never sees.',
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
  description:
    'Prices the partner already has are kept, so copying again adds nothing. Answers the whole list. The partner ' +
    'sees which steps are priced this way, never the numbers.',
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

/**
 * A partner's owner and admins keep its own price list while it is being set up (Partners spec, goal
 * 8); the workspace's own prices stay the workspace's.
 */
@Controller('partner-portal/partners/:partnerId')
export class PortalPricesController {
  constructor(private readonly prices: PartnerPricesService) {}

  @ApiDoc({
    summary: "The partner's own prices, and which steps are priced at the workspace's rates.",
    description: 'Prices staff copied from the workspace are listed under `copied` by step and material only, without their numbers.',
    response: portalPricesResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get('prices')
  list(@CurrentPartner() partner: PartnerAuth): Promise<PortalPricesResponse> {
    return this.prices.portalList(partner);
  }

  @ApiDoc({
    ...PUT,
    description: `${PUT.description} Only while the partner is being set up; once approved, a 409: staff change its prices.`,
    errors: [400, 404, 409],
  })
  @PartnerAccess('admin')
  @Put('step-types/:stepTypeId/prices')
  put(
    @CurrentPartner() partner: PartnerAuth,
    @Param('stepTypeId', idParam) stepTypeId: string,
    @Body(new ZodValidationPipe(stepPriceSchema)) body: z.infer<typeof stepPriceSchema>,
  ): Promise<StepPriceResponse> {
    return this.prices.put(partner, partner.partnerId, stepTypeId, body, 'partner');
  }
}
