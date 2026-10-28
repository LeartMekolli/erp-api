import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { PaymentEvent } from '../../generated/prisma/client';
import { JobsService } from '../../jobs/jobs.service';
import { PaymentAccountService } from './payment-account.service';
import { InvalidSignatureError, PAYMENT_PROVIDER } from './payment-provider';
import type { PaymentProvider, ProviderEvent } from './payment-provider';
import type { WebhookAckResponse } from './payment-response';

export type WebhookEndpoint = 'payments' | 'connect';

/**
 * Applies one event of a type. It runs outside a transaction, must read the object's current
 * state (from the provider or from here) instead of trusting the event, and must be safe to run
 * twice: a retry repeats it.
 */
export type PaymentEventHandlerFn = (tenantId: string, event: PaymentEvent) => Promise<void>;

/**
 * By event type, then by owner, for the whole process. One type may serve several owners (a paid
 * invoice is an order's or a subscription's), each ignoring objects that aren't its own. The same
 * owner registering a type again replaces its handler, so the API's and the worker's module
 * instances can both register at boot.
 */
const handlers = new Map<string, Map<string, PaymentEventHandlerFn>>();

export function registerEventHandler(type: string, handler: PaymentEventHandlerFn, owner = 'default'): void {
  const owners = handlers.get(type) ?? new Map<string, PaymentEventHandlerFn>();
  owners.set(owner, handler);
  handlers.set(type, owners);
}

const ERROR_MAX_LENGTH = 1000;
const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** Payment webhooks (Payments spec, goal 10): verified, stored once, applied once by a job. */
@Injectable()
export class PaymentEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly accounts: PaymentAccountService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /**
   * Verifies the event on the raw body with the endpoint's own secret, stores it and queues it.
   * Nothing is stored unless the workspace is found and active, has keys, and the signature holds.
   */
  async receive(
    tenantId: string,
    endpoint: WebhookEndpoint,
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<WebhookAckResponse> {
    const tenant = isUuid(tenantId)
      ? await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } })
      : null;
    if (!tenant || tenant.status !== 'active') throw new NotFoundException('Workspace not found');

    const secrets = await this.prisma.inTenant(tenantId, (tx) => this.accounts.find(tx));
    if (!secrets) throw new BadRequestException('Payments are not set up for this workspace');
    if (!signature) throw new BadRequestException('The signature is missing');

    let event: ProviderEvent;
    try {
      event = this.provider.verifyEvent(
        rawBody,
        signature,
        endpoint === 'connect' ? secrets.connectWebhookSecret : secrets.webhookSecret,
      );
    } catch (error) {
      if (error instanceof InvalidSignatureError) throw new BadRequestException('The signature is not valid');
      throw error;
    }

    const stored = await this.prisma.inTenant(tenantId, async (tx) => {
      // ON CONFLICT DO NOTHING: two deliveries of one event at once store it once.
      const [created] = await tx.paymentEvent.createManyAndReturn({
        data: [
          {
            providerEventId: event.id,
            type: event.type,
            objectId: event.objectId,
            connectedAccountId: event.connectedAccountId,
            endpoint,
          },
        ],
        skipDuplicates: true,
        select: { id: true, appliedAt: true },
      });
      return (
        created ??
        tx.paymentEvent.findFirstOrThrow({
          where: { providerEventId: event.id },
          select: { id: true, appliedAt: true },
        })
      );
    });

    // Also for a repeat not yet applied: if queueing failed the first time, the provider's retry
    // queues it now. The job id is the row id, so it is never queued twice.
    if (!stored.appliedAt) {
      await this.jobs.enqueue('payments.event', { tenantId, eventId: stored.id });
    }
    return { received: true };
  }

  /**
   * Runs every owner's handler for the event's type in turn, outside any transaction. An event nobody
   * handles is applied as is. A handler's error is kept on the event and rethrown, so the job retries,
   * running every handler again: each is safe to run twice.
   */
  async apply(tenantId: string, eventId: string): Promise<void> {
    const event = await this.prisma.inTenant(tenantId, (tx) => tx.paymentEvent.findFirst({ where: { id: eventId } }));
    if (!event || event.appliedAt) return;

    try {
      for (const handler of handlers.get(event.type)?.values() ?? []) {
        await handler(tenantId, event);
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX_LENGTH);
      await this.prisma.inTenant(tenantId, (tx) =>
        tx.paymentEvent.update({ where: { id: eventId }, data: { error: message } }),
      );
      throw error;
    }
    await this.prisma.inTenant(tenantId, (tx) =>
      tx.paymentEvent.update({ where: { id: eventId }, data: { appliedAt: new Date(), error: null } }),
    );
  }
}
