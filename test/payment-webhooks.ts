import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service';
import type { FakePaymentProvider } from '../src/modules/payments/fake-payment-provider';
import { PaymentAccountService } from '../src/modules/payments/payment-account.service';
import { PAYMENT_PROVIDER } from '../src/modules/payments/payment-provider';
import { waitFor } from './wait-for';

export interface SentEvent {
  id: string;
  type: string;
  objectId: string;
  /** The connected (partner) account the event is about, for Connect events. */
  account?: string;
}

export type Endpoint = 'payments' | 'connect';

export const webhookPath = (tenantId: string, endpoint: Endpoint = 'payments') =>
  endpoint === 'connect' ? `/webhooks/payments/${tenantId}/connect` : `/webhooks/payments/${tenantId}`;

/** The event as the provider sends it: only the parts `verifyEvent` reads. */
export function eventBody(event: SentEvent): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    data: { object: { id: event.objectId } },
    ...(event.account ? { account: event.account } : {}),
  });
}

/** Posts `body` exactly as given, with `signature` as the provider's header when there is one. */
export function postRaw(app: INestApplication, path: string, body: string, signature?: string) {
  const req = request(app.getHttpServer()).post(path).set('Content-Type', 'application/json');
  return (signature === undefined ? req : req.set('Stripe-Signature', signature)).send(body);
}

/**
 * Sends one event to the workspace's webhook, signed with that endpoint's own secret by the fake
 * provider, and waits until the worker has applied it. The worker must be running.
 */
export async function sendEvent(
  app: INestApplication,
  tenantId: string,
  event: SentEvent,
  endpoint: Endpoint = 'payments',
): Promise<request.Response> {
  const prisma = app.get(PrismaService);
  const secrets = await app.get(PaymentAccountService).keysFor(tenantId);
  const fake = app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
  const body = eventBody(event);
  const secret = endpoint === 'connect' ? secrets.connectWebhookSecret : secrets.webhookSecret;

  const res = await postRaw(app, webhookPath(tenantId, endpoint), body, fake.sign(body, secret));
  if (res.status !== 200) {
    throw new Error(`The webhook answered ${res.status}: ${JSON.stringify(res.body)}`);
  }
  await waitFor(() =>
    prisma.inTenant(tenantId, async (tx) => {
      const row = await tx.paymentEvent.findFirst({ where: { providerEventId: event.id } });
      return row?.appliedAt ? row : undefined;
    }),
  );
  return res;
}
