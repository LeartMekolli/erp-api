import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import type { ApiDocOptions } from '../../docs/api-doc';
import { CurrentPartner, CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { PartnerAuth, TenantAuth } from '../identity/auth-context';
import { PartnerAccess, RequirePermission } from '../identity/route-markers';
import { capacityHistoryResponseSchema, partnerResponseSchema, partnerSetupResponseSchema } from './partner-response';
import type { CapacityHistoryResponse, PartnerResponse, PartnerSetupResponse } from './partner-response';
import { PartnersService } from './partners.service';
import {
  SetupService,
  capabilitiesSchema,
  capacityHistoryQuerySchema,
  closedPeriodsSchema,
  limitsSchema,
  offeringsSchema,
} from './setup.service';

const idParam = new ZodValidationPipe(z.uuid());

// The same docs for staff and the partner's own people; only the access differs.
const CAPABILITIES: ApiDocOptions = {
  summary: 'Replace the step types the partner can do, with their limits and capacity.',
  description:
    'Each step type once, with pieces per job, the largest piece size and how many pieces per day or week. ' +
    'Steps nobody prices, such as final QC, are allowed. An unknown step type is a 404.',
  body: capabilitiesSchema,
  response: partnerSetupResponseSchema,
  errors: [400, 404],
};
const CLOSED_PERIODS: ApiDocOptions = {
  summary: 'Replace the days the partner takes no work.',
  description: 'Both dates are included.',
  body: closedPeriodsSchema,
  response: partnerSetupResponseSchema,
  errors: [400, 404],
};
const OFFERINGS: ApiDocOptions = {
  summary: 'Replace the option values the partner works with.',
  description: 'The partner is offered only jobs whose option values it all offers. An unknown value is a 404.',
  body: offeringsSchema,
  response: partnerSetupResponseSchema,
  errors: [400, 404],
};
const LIMITS: ApiDocOptions = {
  summary: 'Change how many jobs the partner takes at once, and whether it takes direct orders from customers.',
  body: limitsSchema,
  response: partnerSetupResponseSchema,
  errors: [400, 404],
};
const SETUP: ApiDocOptions = {
  summary: "The partner's capabilities, capacity, closed periods, offerings and limits.",
  response: partnerSetupResponseSchema,
  errors: [400, 404],
};

/** Staff set a partner up on its behalf (Partners spec, goals 4–6). */
@Controller('partners/:id')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @ApiDoc(SETUP)
  @RequirePermission('partner.read')
  @Get('setup')
  get(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<PartnerSetupResponse> {
    return this.setup.get(tenantId, id);
  }

  @ApiDoc({
    summary: "The partner's load and capacity per step type, as kept each day.",
    description:
      'Kept daily at 02:00 UTC for every step type the partner can do. `from` and `to` are UTC days, both included: ' +
      'by default the last 30 days, at most 366.',
    query: capacityHistoryQuerySchema,
    response: capacityHistoryResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('partner.read')
  @Get('capacity-history')
  capacityHistory(
    @CurrentTenant() tenantId: string,
    @Param('id', idParam) id: string,
    @Query(new ZodValidationPipe(capacityHistoryQuerySchema)) query: z.infer<typeof capacityHistoryQuerySchema>,
  ): Promise<CapacityHistoryResponse> {
    return this.setup.capacityHistory(tenantId, id, query);
  }

  @ApiDoc(CAPABILITIES)
  @RequirePermission('partner.write')
  @Put('capabilities')
  capabilities(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(capabilitiesSchema)) body: z.infer<typeof capabilitiesSchema>,
  ): Promise<PartnerSetupResponse> {
    return this.setup.setCapabilities(auth, id, body);
  }

  @ApiDoc(CLOSED_PERIODS)
  @RequirePermission('partner.write')
  @Put('closed-periods')
  closedPeriods(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(closedPeriodsSchema)) body: z.infer<typeof closedPeriodsSchema>,
  ): Promise<PartnerSetupResponse> {
    return this.setup.setClosedPeriods(auth, id, body);
  }

  @ApiDoc(OFFERINGS)
  @RequirePermission('partner.write')
  @Put('offerings')
  offerings(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(offeringsSchema)) body: z.infer<typeof offeringsSchema>,
  ): Promise<PartnerSetupResponse> {
    return this.setup.setOfferings(auth, id, body);
  }

  @ApiDoc(LIMITS)
  @RequirePermission('partner.write')
  @Patch('limits')
  limits(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(limitsSchema)) body: z.infer<typeof limitsSchema>,
  ): Promise<PartnerSetupResponse> {
    return this.setup.setLimits(auth, id, body);
  }
}

/** A partner's owner and admins set it up themselves (Partners spec, goals 4–6 and 17). */
@Controller('partner-portal/partners/:partnerId')
export class PortalSetupController {
  constructor(
    private readonly setup: SetupService,
    private readonly partners: PartnersService,
  ) {}

  @ApiDoc(SETUP)
  @PartnerAccess('member')
  @Get('setup')
  get(@CurrentPartner() partner: PartnerAuth): Promise<PartnerSetupResponse> {
    return this.setup.get(partner.tenantId, partner.partnerId);
  }

  @ApiDoc(CAPABILITIES)
  @PartnerAccess('admin')
  @Put('capabilities')
  capabilities(
    @CurrentPartner() partner: PartnerAuth,
    @Body(new ZodValidationPipe(capabilitiesSchema)) body: z.infer<typeof capabilitiesSchema>,
  ): Promise<PartnerSetupResponse> {
    return this.setup.setCapabilities(partner, partner.partnerId, body);
  }

  @ApiDoc(CLOSED_PERIODS)
  @PartnerAccess('admin')
  @Put('closed-periods')
  closedPeriods(
    @CurrentPartner() partner: PartnerAuth,
    @Body(new ZodValidationPipe(closedPeriodsSchema)) body: z.infer<typeof closedPeriodsSchema>,
  ): Promise<PartnerSetupResponse> {
    return this.setup.setClosedPeriods(partner, partner.partnerId, body);
  }

  @ApiDoc(OFFERINGS)
  @PartnerAccess('admin')
  @Put('offerings')
  offerings(
    @CurrentPartner() partner: PartnerAuth,
    @Body(new ZodValidationPipe(offeringsSchema)) body: z.infer<typeof offeringsSchema>,
  ): Promise<PartnerSetupResponse> {
    return this.setup.setOfferings(partner, partner.partnerId, body);
  }

  @ApiDoc(LIMITS)
  @PartnerAccess('admin')
  @Patch('limits')
  limits(
    @CurrentPartner() partner: PartnerAuth,
    @Body(new ZodValidationPipe(limitsSchema)) body: z.infer<typeof limitsSchema>,
  ): Promise<PartnerSetupResponse> {
    return this.setup.setLimits(partner, partner.partnerId, body);
  }

  @ApiDoc({
    summary: 'Tell staff the setup is ready for approval.',
    description: 'Staff are notified the first time; submitting again changes nothing. A partner no longer being set up is a 409.',
    response: partnerResponseSchema,
    errors: [400, 404, 409],
  })
  @PartnerAccess('owner')
  @Post('submit')
  @HttpCode(200)
  submit(@CurrentPartner() partner: PartnerAuth): Promise<PartnerResponse> {
    return this.partners.submit(partner);
  }
}
