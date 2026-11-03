import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PrismaService } from '../../database/prisma.service';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentCustomer, CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { CustomerAuth, TenantAuth } from '../identity/auth-context';
import { CustomerAccess, RequirePermission } from '../identity/route-markers';
import { CourierAccountService } from './courier-account.service';
import {
  courierAccountResponseSchema,
  portalShippingRatesSchema,
  setCourierAccountSchema,
  shippingRatesResponseSchema,
  shippingRatesSchema,
} from './courier-response';
import type { CourierAccountResponse, PortalShippingRatesBody, SetCourierAccount, ShippingRatesBody, ShippingRatesResponse } from './courier-response';
import { RatesService } from './rates.service';

const RATES_DESCRIPTION =
  'A fixed-price method answers its price; a live-rate one is priced now by the courier service for its default parcel ' +
  "to the address. One with no courier account, no rate for its service, or a rate in another currency than the workspace's " +
  'reads `available: false` with the reason. The address given, else the customer’s saved shipping address.';

/** The workspace's courier service account (Orders 3 spec, goal 21): key in, never out. */
@Controller('couriers/account')
export class CourierAccountController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly account: CourierAccountService,
  ) {}

  @ApiDoc({
    summary: "Whether the workspace's courier service is set up, its mode, its address and the webhook address to register.",
    description: 'Never includes the key or the webhook secret.',
    response: courierAccountResponseSchema,
  })
  @RequirePermission('settings.read')
  @Get()
  get(@CurrentTenant() tenantId: string): Promise<CourierAccountResponse> {
    return this.prisma.inTenant(tenantId, (tx) => this.account.view(tx, tenantId));
  }

  @ApiDoc({
    summary: "Set the workspace's courier service key, webhook secret and ship-from address, replacing any set before.",
    description: 'The key and the secret are sealed at rest and never returned.',
    body: setCourierAccountSchema,
    response: courierAccountResponseSchema,
    errors: [400],
  })
  @RequirePermission('settings.write')
  @Put()
  set(@CurrentUser() auth: TenantAuth, @Body(new ZodValidationPipe(setCourierAccountSchema)) body: SetCourierAccount): Promise<CourierAccountResponse> {
    return this.prisma.inTenant(auth.tenantId, (tx) => this.account.set(tx, auth.tenantId, { type: 'user', id: auth.userId }, body));
  }
}

/** Shipping prices for an order before it is placed (Orders 3 spec, goal 22). */
@Controller()
export class ShippingRatesController {
  constructor(private readonly rates: RatesService) {}

  @ApiDoc({
    summary: "Each active shipping method's price for an order of the customer to an address.",
    description: RATES_DESCRIPTION,
    body: shippingRatesSchema,
    response: shippingRatesResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('order.write')
  @Post('orders/shipping-rates')
  @HttpCode(200)
  staff(@CurrentTenant() tenantId: string, @Body(new ZodValidationPipe(shippingRatesSchema)) body: ShippingRatesBody): Promise<ShippingRatesResponse> {
    return this.rates.forOrder(tenantId, { customerId: body.customer_id, address: body.address });
  }

  @ApiDoc({
    summary: "Each shipping method's price for the customer's next order to an address.",
    description: RATES_DESCRIPTION,
    body: portalShippingRatesSchema,
    response: shippingRatesResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('buyer')
  @Post('portal/customers/:customerId/shipping-rates')
  @HttpCode(200)
  portal(
    @CurrentCustomer() customer: CustomerAuth,
    @Body(new ZodValidationPipe(portalShippingRatesSchema)) body: PortalShippingRatesBody,
  ): Promise<ShippingRatesResponse> {
    return this.rates.forOrder(customer.tenantId, { customerId: customer.customerId, address: body.address });
  }
}
