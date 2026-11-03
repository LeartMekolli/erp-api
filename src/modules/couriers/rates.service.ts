import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { Address } from '../orders/order-response';
import { COURIER_PROVIDER, CourierError } from './courier-provider';
import type { CourierProvider, CourierRate, Parcel } from './courier-provider';
import { CourierAccountService } from './courier-account.service';
import type { ShippingRatesResponse } from './courier-response';

/** A live method as a rate is asked for it. */
export interface LiveMethod {
  key: string;
  liveCarrier: string;
  liveService: string;
  defaultParcel: Parcel;
}

/** A live rate for one order: its price, or why the method can't be used, and whether the service failed. */
export type LiveRate = { ok: true; price: Prisma.Decimal } | { ok: false; reason: string; down: boolean };

/**
 * Live shipping rates (Orders 3 spec, goal 22): the courier service's price for a method's default parcel
 * to an address, asked outside any transaction. A rate in another currency than the workspace's, or none
 * for the method's service, refuses the method for that order; nothing is converted.
 */
@Injectable()
export class RatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: CourierAccountService,
    @Inject(COURIER_PROVIDER) private readonly provider: CourierProvider,
  ) {}

  /** Every active method's price for an order of `customerId` to `address`, else to the customer's saved one. */
  async forOrder(tenantId: string, input: { customerId: string; address?: Address }): Promise<ShippingRatesResponse> {
    const { methods, address } = await this.prisma.inTenant(tenantId, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: input.customerId }, select: { shippingAddress: true } });
      if (!customer) throw new NotFoundException('Customer not found');
      return {
        methods: await tx.shippingMethod.findMany({ where: { active: true }, orderBy: { key: 'asc' } }),
        address: input.address ?? (customer.shippingAddress as Address | null),
      };
    });
    const data: ShippingRatesResponse['data'] = [];
    for (const method of methods) {
      if (method.price !== null) {
        data.push({ key: method.key, name: method.name, price: method.price.toFixed(2), available: true, reason: null });
        continue;
      }
      const rate = address
        ? await this.rate(tenantId, method as unknown as LiveMethod, address)
        : ({ ok: false, reason: 'Give an address to price this method', down: false } as const);
      data.push(
        rate.ok
          ? { key: method.key, name: method.name, price: rate.price.toFixed(2), available: true, reason: null }
          : { key: method.key, name: method.name, price: null, available: false, reason: rate.reason },
      );
    }
    return { data };
  }

  /** One live method's rate to `address`. Never throws for the service's refusal; `down` when it failed. */
  async rate(tenantId: string, method: LiveMethod, address: Address): Promise<LiveRate> {
    const { account, currency } = await this.prisma.inTenant(tenantId, async (tx) => ({
      account: await this.accounts.find(tx),
      currency: (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } })).defaultCurrency,
    }));
    if (!account) return { ok: false, reason: 'No courier service is set up for this workspace', down: false };
    let rates: CourierRate[];
    try {
      ({ rates } = await this.provider.shipment(account.keys, {
        from: account.fromAddress,
        to: address,
        parcel: method.defaultParcel,
        isReturn: false,
        reference: `rate:${method.key}`,
      }));
    } catch (error) {
      if (error instanceof CourierError) return { ok: false, reason: error.message, down: true };
      throw error;
    }
    const rate = rates.find((one) => one.carrier === method.liveCarrier && one.service === method.liveService);
    if (!rate) return { ok: false, reason: `${method.liveCarrier} offers no ${method.liveService} rate to this address`, down: false };
    if (rate.currency !== currency) {
      return { ok: false, reason: `${method.liveCarrier} prices this in ${rate.currency}, not the workspace's ${currency}`, down: false };
    }
    return { ok: true, price: rate.amount.toDecimalPlaces(2) };
  }
}
