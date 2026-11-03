import type { Prisma } from '../../generated/prisma/client';
import type { Address } from '../orders/order-response';

/**
 * The one way the API talks to a courier service (Orders 3 spec, goal 21): our own shapes, so a service
 * other than EasyPost could replace it. Only ever called outside a database transaction.
 */

/** One workspace's courier account key. Sealed at rest, never logged. */
export interface CourierKeys {
  apiKey: string;
}

/** A parcel as staff measure it; the provider converts to the service's units. */
export interface Parcel {
  weight_g: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
}

export interface CourierRate {
  carrier: string;
  service: string;
  amount: Prisma.Decimal;
  currency: string;
}

export interface CourierLabel {
  tracking: string;
  labelUrl: string;
  amount: Prisma.Decimal;
  currency: string;
}

export const TRACKING_STATUSES = ['pre_transit', 'in_transit', 'out_for_delivery', 'delivered', 'returned', 'failure', 'unknown'] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

/** The facts of a tracking event; the payload itself is never kept. */
export interface CourierEvent {
  id: string;
  tracking: string;
  status: TrackingStatus;
}

export interface CourierProvider {
  /** A shipment at the service, with its rates; a label is bought from it later. */
  shipment(
    keys: CourierKeys,
    input: { from: Address; to: Address; parcel: Parcel; isReturn: boolean; reference: string },
  ): Promise<{ providerShipmentId: string; rates: CourierRate[] }>;
  /** Buys the shipment's label at the named carrier and service. */
  buy(keys: CourierKeys, providerShipmentId: string, carrier: string, service: string): Promise<CourierLabel>;
  /** The shipment's label if it was bought, else null: a purchase whose answer was lost is never bought twice. */
  label(keys: CourierKeys, providerShipmentId: string): Promise<CourierLabel | null>;
  /**
   * Checks a webhook's signature with the account's secret (throws InvalidSignatureError) and reads it:
   * null for an event that isn't a tracking update, which is answered and left alone.
   */
  verifyEvent(rawBody: Buffer, signature: string | undefined, secret: string): CourierEvent | null;
}

/** DI token: the fake for tests and local work, EasyPost otherwise (`COURIER_PROVIDER`). */
export const COURIER_PROVIDER = Symbol('COURIER_PROVIDER');

/** The service refused or failed; its message is safe to show staff. */
export class CourierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CourierError';
  }
}
