import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentCustomer, CurrentTenant } from '../../identity/auth-context';
import type { CustomerAuth } from '../../identity/auth-context';
import { CustomerAccess, RequirePermission } from '../../identity/route-markers';
import { payLinkResponseSchema } from '../payment-response';
import type { PayLinkResponse } from '../payment-response';
import {
  portalPlanListResponseSchema,
  subscriptionChangeSchema,
  subscriptionCheckoutSchema,
  subscriptionResponseSchema,
} from './plan-response';
import type { PortalPlanListResponse, SubscriptionChange, SubscriptionCheckout, SubscriptionResponse } from './plan-response';
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
    summary: "Move the customer's subscription to another plan or interval.",
    description:
      'Costing as much or more a month, it applies at once, charged the prorated difference: 202, and the plan changes ' +
      'only once that payment is taken. Costing less, it applies at the end of the period: 200, shown as `change`. The ' +
      'free plan ends the subscription at the end of the period; the current plan and interval undo a change asked ' +
      'before. A 409 without an active subscription (subscribe through checkout), while a payment is late, or for a ' +
      'plan not sold. A 503 when the payment provider does not answer.',
    body: subscriptionChangeSchema,
    response: subscriptionResponseSchema,
    errors: [400, 404, 409, 503],
  })
  @CustomerAccess('owner')
  @Post('portal/customers/:customerId/subscription/change')
  async change(
    @CurrentCustomer() customer: CustomerAuth,
    @Body(new ZodValidationPipe(subscriptionChangeSchema)) body: SubscriptionChange,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubscriptionResponse> {
    const { pending, view } = await this.subscriptions.change(customer.tenantId, customer.customerId, body);
    res.status(pending ? 202 : 200);
    return view;
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
