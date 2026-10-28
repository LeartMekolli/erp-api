import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentCustomer, CurrentTenant, CurrentUser } from '../../identity/auth-context';
import type { CustomerAuth, TenantAuth } from '../../identity/auth-context';
import { CustomerAccess, RequirePermission } from '../../identity/route-markers';
import { payLinkResponseSchema } from '../payment-response';
import type { PayLinkResponse } from '../payment-response';
import { CreditPacksService } from './credit-packs.service';
import { createCreditPackSchema, creditPackListResponseSchema, creditPackResponseSchema, updateCreditPackSchema } from './credit-response';
import type { CreateCreditPack, CreditPackListResponse, CreditPackResponse, UpdateCreditPack } from './credit-response';

const idParam = new ZodValidationPipe(z.uuid());

/** Credit packs (Payments 2 spec, goal 10): staff make them, a customer's owner buys them on any plan. */
@Controller()
export class CreditPacksController {
  constructor(private readonly packs: CreditPacksService) {}

  @ApiDoc({
    summary: 'Every credit pack of the workspace, archived ones included, in display order.',
    response: creditPackListResponseSchema,
  })
  @RequirePermission('payment.read')
  @Get('payments/credit-packs')
  list(@CurrentTenant() tenantId: string): Promise<CreditPackListResponse> {
    return this.packs.list(tenantId);
  }

  @ApiDoc({
    summary: "Create a pack of credits sold once at a price in the workspace's currency, lasting a number of days from payment.",
    body: createCreditPackSchema,
    response: creditPackResponseSchema,
    errors: [400],
  })
  @RequirePermission('plan.write')
  @Post('payments/credit-packs')
  create(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createCreditPackSchema)) body: CreateCreditPack,
  ): Promise<CreditPackResponse> {
    return this.packs.create(auth, body);
  }

  @ApiDoc({
    summary: 'Change a credit pack, or stop selling it with `status: archived`; purchases made keep what they were sold as.',
    body: updateCreditPackSchema,
    response: creditPackResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('plan.write')
  @Patch('payments/credit-packs/:id')
  update(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateCreditPackSchema)) body: UpdateCreditPack,
  ): Promise<CreditPackResponse> {
    return this.packs.update(auth, id, body);
  }

  @ApiDoc({
    summary: 'The credit packs the customer can buy, on any plan.',
    response: creditPackListResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get('portal/customers/:customerId/credit-packs')
  forSale(@CurrentCustomer() customer: CustomerAuth): Promise<CreditPackListResponse> {
    return this.packs.forSale(customer.tenantId);
  }

  @ApiDoc({
    summary: "Get a link to the payment provider's checkout to buy a credit pack at its price now.",
    description:
      'The credits arrive once the provider confirms the payment. A 409 for a pack no longer sold, or before the ' +
      'workspace has set up payments; a 503 when the payment provider does not answer, and asking again is safe.',
    response: payLinkResponseSchema,
    errors: [400, 404, 409, 503],
  })
  @CustomerAccess('owner')
  @Post('portal/customers/:customerId/credit-packs/:packId/buy')
  @HttpCode(200)
  buy(@CurrentCustomer() customer: CustomerAuth, @Param('packId', idParam) packId: string): Promise<PayLinkResponse> {
    return this.packs.buy(customer, packId);
  }
}
