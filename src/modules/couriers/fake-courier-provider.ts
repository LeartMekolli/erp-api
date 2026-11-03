import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import type { Address } from '../orders/order-response';
import { CourierError } from './courier-provider';
import type { CourierEvent, CourierKeys, CourierLabel, CourierProvider, CourierRate, Parcel } from './courier-provider';
import { easyPostSignature, readEasyPostEvent } from './easypost-events';

/** The fake's services: a base price and a price per started kilo. */
const SERVICES = [
  { service: 'standard', base: '4.90', perKg: '1.00' },
  { service: 'express', base: '9.90', perKg: '2.00' },
];
export const FAKE_CARRIER = 'FakeCarrier';

/** Signs a body as EasyPost does, so a test can send the fake's webhook. */
export function signFakeCourierEvent(rawBody: Buffer, secret: string): string {
  return easyPostSignature(rawBody, secret);
}

/**
 * In memory, for local work, tests and the demo: `FakeCarrier` with `standard` (4.90 + 1.00 a started kg)
 * and `express` (9.90 + 2.00), in EUR, or USD to a US address. An address whose first line is `FAIL` is
 * refused at purchase. Records every label bought.
 */
export class FakeCourierProvider implements CourierProvider {
  readonly bought: { providerShipmentId: string; carrier: string; service: string; tracking: string }[] = [];
  private readonly shipments = new Map<string, { to: Address; rates: CourierRate[] }>();
  private labels = 0;

  shipment(
    _keys: CourierKeys,
    input: { from: Address; to: Address; parcel: Parcel; isReturn: boolean; reference: string },
  ): Promise<{ providerShipmentId: string; rates: CourierRate[] }> {
    const kilos = Math.max(1, Math.ceil(input.parcel.weight_g / 1_000));
    const currency = input.to.country === 'US' ? 'USD' : 'EUR';
    const rates = SERVICES.map(({ service, base, perKg }) => ({
      carrier: FAKE_CARRIER,
      service,
      amount: new Prisma.Decimal(base).add(new Prisma.Decimal(perKg).mul(kilos)),
      currency,
    }));
    const providerShipmentId = `shp_fake_${randomUUID()}`;
    this.shipments.set(providerShipmentId, { to: input.to, rates });
    return Promise.resolve({ providerShipmentId, rates });
  }

  buy(_keys: CourierKeys, providerShipmentId: string, carrier: string, service: string): Promise<CourierLabel> {
    const shipment = this.shipments.get(providerShipmentId);
    if (!shipment) return Promise.reject(new CourierError('No such shipment'));
    if (shipment.to.line1 === 'FAIL') return Promise.reject(new CourierError('The address was refused'));
    const rate = shipment.rates.find((one) => one.carrier === carrier && one.service === service);
    if (!rate) return Promise.reject(new CourierError(`${carrier} offers no ${service} rate for this parcel`));
    this.labels += 1;
    const tracking = `FAKE${String(this.labels).padStart(6, '0')}`;
    this.bought.push({ providerShipmentId, carrier, service, tracking });
    return Promise.resolve({ tracking, labelUrl: `https://labels.example.test/${providerShipmentId}.pdf`, amount: rate.amount, currency: rate.currency });
  }

  verifyEvent(rawBody: Buffer, signature: string | undefined, secret: string): CourierEvent | null {
    return readEasyPostEvent(rawBody, signature, secret);
  }
}
