import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidSignatureError } from '../payments/payment-provider';
import type { CourierEvent, TrackingStatus } from './courier-provider';

const PREFIX = 'hmac-sha256-hex=';

/** EasyPost's tracker states, as ours. */
const STATUS: Record<string, TrackingStatus> = {
  pre_transit: 'pre_transit',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  available_for_pickup: 'out_for_delivery',
  delivered: 'delivered',
  return_to_sender: 'returned',
  failure: 'failure',
  cancelled: 'failure',
  error: 'failure',
};

/** EasyPost's `X-Hmac-Signature`: `hmac-sha256-hex=` and the HMAC-SHA256 of the raw body, keyed by the NFKD secret. */
export function easyPostSignature(rawBody: Buffer, secret: string): string {
  return `${PREFIX}${createHmac('sha256', secret.normalize('NFKD')).update(rawBody).digest('hex')}`;
}

/**
 * Checks the signature, then reads a `tracker.updated` event: its id, tracking number and state. Any
 * other event is null. Shared by the EasyPost provider and its fake, so tests sign as EasyPost does.
 */
export function readEasyPostEvent(rawBody: Buffer, signature: string | undefined, secret: string): CourierEvent | null {
  const expected = Buffer.from(easyPostSignature(rawBody, secret));
  const given = Buffer.from(signature ?? '');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new InvalidSignatureError();
  }
  let event: { id?: unknown; description?: unknown; result?: { tracking_code?: unknown; status?: unknown } };
  try {
    event = JSON.parse(rawBody.toString('utf8')) as typeof event;
  } catch {
    throw new InvalidSignatureError('The body is not an event');
  }
  if (event.description !== 'tracker.updated' || typeof event.id !== 'string' || typeof event.result?.tracking_code !== 'string') {
    return null;
  }
  const status = typeof event.result.status === 'string' ? (STATUS[event.result.status] ?? 'unknown') : 'unknown';
  return { id: event.id, tracking: event.result.tracking_code, status };
}
