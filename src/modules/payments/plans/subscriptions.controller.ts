import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentCustomer, CurrentTenant } from '../../identity/auth-context';
import type { CustomerAuth } from '../../identity/auth-context';
import { CustomerAccess, RequirePermission } from '../../identity/route-markers';
import { payLinkResponseSchema } from '../payment-response';
import type { PayLinkResponse } from '../payment-response';
import { portalPlanListResponseSchema, subscriptionCheckoutSchema, subscriptionResponseSchema } from './plan-response';
import type { PortalPlanListResponse, SubscriptionCheckout, SubscriptionResponse } from './plan-response';
import { SubscriptionsService } from './subscriptions.service';

const idParam = new ZodValidationPipe(z.uuid());

const SUBSCRIPTION =
  "On the free default plan, `status` is `free` and the rest is empty. A subscription whose payment is late is `past_due` and keeps its plan's benefits.";

/** Customers subscribe to a plan through the payment provider (Payments 2 spec, goals 4–6). */
@Controller()
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @ApiDoc({
    summary: 'The plans the customer can choose, with their prices and benefits, its own marked as current.',
    response: portalPlanListResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get('portal/customers/:customerId/plans')
  plans(@CurrentCustomer() customer: CustomerAuth): Promise<PortalPlanListResponse> {
    return this.subscriptions.portalPlans(customer.tenantId, customer.customerId);
  }

  @ApiDoc({
    summary: "The customer's own subscription: its plan, price, state and any change at the end of the period.",
    description: SUBSCRIPTION,
    response: subscriptionResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get('portal/customers/:customerId/subscription')
  own(@CurrentCustomer() customer: CustomerAuth): Promise<SubscriptionResponse> {
    return this.subscriptions.view(customer.tenantId, customer.customerId);
  }

  @ApiDoc({
    summary: "A customer's subscription: its plan, price, state and any change at the end of the period.",
    description: SUBSCRIPTION,
    response: subscriptionResponseSchema,
    errors: [404],
  })
  @RequirePermission('payment.read')
  @Get('payments/customers/:id/subscription')
  ofCustomer(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<SubscriptionResponse> {
    return this.subscriptions.view(tenantId, id);
  }

  @ApiDoc({
    summary: "Get a link to the payment provider's checkout to subscribe to a paid plan.",
    description:
      "The plan's current price for the interval is charged; each ask gives a new link. A customer that holds a " +
      'subscription changes it in the billing portal instead: a 409, as for the free plan, an archived plan or one not ' +
      'published yet. A 503 when the payment provider does not answer; asking again is safe.',
    body: subscriptionCheckoutSchema,
    response: payLinkResponseSchema,
    errors: [400, 404, 409, 503],
  })
  @CustomerAccess('owner')
  @Post('portal/customers/:customerId/subscription/checkout')
  @HttpCode(200)
  checkout(
    @CurrentCustomer() customer: CustomerAuth,
    @Body(new ZodValidationPipe(subscriptionCheckoutSchema)) body: SubscriptionCheckout,
  ): Promise<PayLinkResponse> {
    return this.subscriptions.checkout(customer.tenantId, customer.customerId, body);
  }

  @ApiDoc({
    summary: "Get a link to the payment provider's billing portal, to change the card or the plan, or to cancel.",
    description: 'A 503 when the payment provider does not answer; asking again is safe.',
    response: payLinkResponseSchema,
    errors: [400, 404, 409, 503],
  })
  @CustomerAccess('owner')
  @Post('portal/customers/:customerId/billing-portal')
  @HttpCode(200)
  billingPortal(@CurrentCustomer() customer: CustomerAuth): Promise<PayLinkResponse> {
    return this.subscriptions.billingPortal(customer.tenantId, customer.customerId);
  }
}
