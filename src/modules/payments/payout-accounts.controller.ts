import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentPartner, CurrentTenant } from '../identity/auth-context';
import type { PartnerAuth } from '../identity/auth-context';
import { PartnerAccess, RequirePermission } from '../identity/route-markers';
import { payoutAccountResponseSchema, payoutLinkResponseSchema } from './payment-response';
import type { PayoutAccountResponse, PayoutLinkResponse } from './payment-response';
import { PayoutAccountsService } from './payout-accounts.service';

const idParam = new ZodValidationPipe(z.uuid());

const LINK_DESCRIPTION =
  'The first link makes the partner an account at the payment provider; each later one opens the same account. ' +
  'A link works once, until it expires; ask again for a new one. A 409 when the workspace has no payment keys.';
const STATE_DESCRIPTION =
  '`not_connected` until a link is asked for; `onboarding` until the provider has what it needs; `ready` once the ' +
  'partner can be paid; `restricted` when the provider needs more from it.';

/** The accounts partners are paid through (Payments spec), for the partner and for staff. */
@Controller()
export class PayoutAccountsController {
  constructor(private readonly payouts: PayoutAccountsService) {}

  @ApiDoc({ summary: "Where the partner's payout account stands.", description: STATE_DESCRIPTION, response: payoutAccountResponseSchema, errors: [400, 404] })
  @PartnerAccess('admin')
  @Get('partner-portal/partners/:partnerId/payout-account')
  portalState(@CurrentPartner() partner: PartnerAuth): Promise<PayoutAccountResponse> {
    return this.payouts.state(partner.tenantId, partner.partnerId);
  }

  @ApiDoc({
    summary: 'Get a link to set up, or finish, the payout account the partner is paid through.',
    description: LINK_DESCRIPTION,
    response: payoutLinkResponseSchema,
    errors: [400, 404, 409],
  })
  @PartnerAccess('owner')
  @Post('partner-portal/partners/:partnerId/payout-account/link')
  @HttpCode(200)
  portalLink(@CurrentPartner() partner: PartnerAuth): Promise<PayoutLinkResponse> {
    return this.payouts.link(partner.tenantId, partner.partnerId);
  }

  @ApiDoc({ summary: "Where a partner's payout account stands.", description: STATE_DESCRIPTION, response: payoutAccountResponseSchema, errors: [400, 404] })
  @RequirePermission('partner.read')
  @Get('partners/:id/payout-account')
  state(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<PayoutAccountResponse> {
    return this.payouts.state(tenantId, id);
  }

  @ApiDoc({
    summary: "Get a link to send a partner, to set up or finish the payout account it is paid through.",
    description: LINK_DESCRIPTION,
    response: payoutLinkResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('partner.write')
  @Post('partners/:id/payout-account/link')
  @HttpCode(200)
  link(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<PayoutLinkResponse> {
    return this.payouts.link(tenantId, id);
  }
}
