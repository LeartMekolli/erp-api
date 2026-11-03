import { Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type { Address } from '../orders/order-response';
import { CourierError } from './courier-provider';
import type { CourierEvent, CourierKeys, CourierLabel, CourierProvider, CourierRate, Parcel } from './courier-provider';
import { readEasyPostEvent } from './easypost-events';

const API = 'https://api.easypost.com/v2';
const GRAMS_PER_OUNCE = 28.349523125;
const CM_PER_INCH = 2.54;
const TIMEOUT_MS = 20_000;

const oneDecimal = (value: number) => Math.round(value * 10) / 10;

function easyPostAddress(address: Address) {
  return {
    name: address.name,
    street1: address.line1,
    ...(address.line2 ? { street2: address.line2 } : {}),
    city: address.city,
    ...(address.region ? { state: address.region } : {}),
    zip: address.postal_code,
    country: address.country,
    ...(address.phone ? { phone: address.phone } : {}),
  };
}

/** The body of EasyPost's `POST /shipments`: addresses in its fields, the parcel in ounces and inches. */
export function easyPostShipmentBody(input: { from: Address; to: Address; parcel: Parcel; isReturn: boolean; reference: string }) {
  return {
    shipment: {
      from_address: easyPostAddress(input.from),
      to_address: easyPostAddress(input.to),
      parcel: {
        weight: oneDecimal(input.parcel.weight_g / GRAMS_PER_OUNCE),
        length: oneDecimal(input.parcel.length_cm / CM_PER_INCH),
        width: oneDecimal(input.parcel.width_cm / CM_PER_INCH),
        height: oneDecimal(input.parcel.height_cm / CM_PER_INCH),
      },
      is_return: input.isReturn,
      reference: input.reference,
    },
  };
}

interface EasyPostRate {
  id: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
}

/** The parts of an EasyPost shipment read here; the label fields are null until it is bought. */
interface EasyPostShipment {
  rates: EasyPostRate[];
  tracking_code: string | null;
  postage_label: { label_url: string } | null;
  selected_rate: EasyPostRate | null;
}

function boughtLabel(shipment: EasyPostShipment): CourierLabel | null {
  if (!shipment.tracking_code || !shipment.postage_label || !shipment.selected_rate) return null;
  return {
    tracking: shipment.tracking_code,
    labelUrl: shipment.postage_label.label_url,
    amount: new Prisma.Decimal(shipment.selected_rate.rate),
    currency: shipment.selected_rate.currency,
  };
}

/**
 * EasyPost over its REST API (Orders 3 spec, "My calls"), with each workspace's own key. Checked against
 * EasyPost's API reference (v2: shipments, buy, tracker events and `X-Hmac-Signature`) when written; a
 * refusal comes back as a CourierError with EasyPost's message.
 */
export class EasyPostCourierProvider implements CourierProvider {
  private readonly logger = new Logger(EasyPostCourierProvider.name);

  async shipment(
    keys: CourierKeys,
    input: { from: Address; to: Address; parcel: Parcel; isReturn: boolean; reference: string },
  ): Promise<{ providerShipmentId: string; rates: CourierRate[] }> {
    const shipment = await this.call<{ id: string; rates: EasyPostRate[] }>(keys, 'POST', '/shipments', easyPostShipmentBody(input));
    return { providerShipmentId: shipment.id, rates: shipment.rates.map(toRate) };
  }

  async buy(keys: CourierKeys, providerShipmentId: string, carrier: string, service: string): Promise<CourierLabel> {
    const shipment = await this.call<EasyPostShipment>(keys, 'GET', `/shipments/${encodeURIComponent(providerShipmentId)}`);
    // EasyPost refuses to buy a shipment twice: one bought already answers its label.
    const already = boughtLabel(shipment);
    if (already) return already;
    const rate = shipment.rates.find((one) => one.carrier === carrier && one.service === service);
    if (!rate) throw new CourierError(`${carrier} offers no ${service} rate for this parcel`);
    const bought = boughtLabel(
      await this.call<EasyPostShipment>(keys, 'POST', `/shipments/${encodeURIComponent(providerShipmentId)}/buy`, { rate: { id: rate.id } }),
    );
    if (!bought) throw new CourierError('The courier service answered the purchase without a label');
    return bought;
  }

  async label(keys: CourierKeys, providerShipmentId: string): Promise<CourierLabel | null> {
    return boughtLabel(await this.call<EasyPostShipment>(keys, 'GET', `/shipments/${encodeURIComponent(providerShipmentId)}`));
  }

  verifyEvent(rawBody: Buffer, signature: string | undefined, secret: string): CourierEvent | null {
    return readEasyPostEvent(rawBody, signature, secret);
  }

  private async call<T>(keys: CourierKeys, method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Basic ${Buffer.from(`${keys.apiKey}:`).toString('base64')}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn({ err: error, path }, 'EasyPost could not be reached');
      throw new CourierError('The courier service could not be reached');
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!response.ok) {
      throw new CourierError(payload.error?.message ?? `The courier service answered ${response.status}`);
    }
    return payload as T;
  }
}

function toRate(rate: EasyPostRate): CourierRate {
  return { carrier: rate.carrier, service: rate.service, amount: new Prisma.Decimal(rate.rate), currency: rate.currency };
}
