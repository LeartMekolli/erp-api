import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { JobsService } from '../../jobs/jobs.service';
import { InvalidSignatureError } from '../payments/payment-provider';
import type { WebhookAckResponse } from '../payments/payment-response';
import { CourierAccountService } from './courier-account.service';
import { COURIER_PROVIDER } from './courier-provider';
import type { CourierEvent, CourierProvider, TrackingStatus } from './courier-provider';
import { ShipmentsService } from './shipments.service';

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** Tracking webhooks (Orders 3 spec, goal 24): verified, stored once, applied once by a job, as payment webhooks are. */
@Injectable()
export class CourierEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly accounts: CourierAccountService,
    private readonly shipments: ShipmentsService,
    @Inject(COURIER_PROVIDER) private readonly provider: CourierProvider,
  ) {}

  /**
   * Verifies the event on the raw body with the account's webhook secret, stores it and queues it.
   * Nothing is stored unless the workspace is found and active, has an account, and the signature holds;
   * an event that isn't a tracking update is answered and left alone.
   */
  async receive(tenantId: string, rawBody: Buffer, signature: string | undefined): Promise<WebhookAckResponse> {
    const tenant = isUuid(tenantId) ? await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } }) : null;
    if (!tenant || tenant.status !== 'active') throw new NotFoundException('Workspace not found');

    const account = await this.accounts.findFor(tenantId);
    if (!account) throw new BadRequestException('No courier service is set up for this workspace');
    if (!signature) throw new BadRequestException('The signature is missing');

    let event: CourierEvent | null;
    try {
      event = this.provider.verifyEvent(rawBody, signature, account.webhookSecret);
    } catch (error) {
      if (error instanceof InvalidSignatureError) throw new BadRequestException('The signature is not valid');
      throw error;
    }
    if (!event) return { received: true };
    const found = event;

    const stored = await this.prisma.inTenant(tenantId, async (tx) => {
      // ON CONFLICT DO NOTHING: two deliveries of one event at once store it once.
      const [created] = await tx.courierEvent.createManyAndReturn({
        data: [{ providerEventId: found.id, tracking: found.tracking, status: found.status }],
        skipDuplicates: true,
        select: { id: true, appliedAt: true },
      });
      return created ?? tx.courierEvent.findFirstOrThrow({ where: { providerEventId: found.id }, select: { id: true, appliedAt: true } });
    });
    // Also for a repeat not yet applied: if queueing failed the first time, the service's retry queues it now.
    if (!stored.appliedAt) {
      await this.jobs.enqueue('couriers.event', { tenantId, eventId: stored.id });
    }
    return { received: true };
  }

  /** Applies one stored event, outside any transaction; a second time changes nothing. */
  async apply(tenantId: string, eventId: string): Promise<void> {
    const event = await this.prisma.inTenant(tenantId, (tx) => tx.courierEvent.findFirst({ where: { id: eventId } }));
    if (!event || event.appliedAt) return;
    await this.shipments.applyTracking(tenantId, event.tracking, event.status as TrackingStatus);
    await this.prisma.inTenant(tenantId, (tx) => tx.courierEvent.update({ where: { id: eventId }, data: { appliedAt: new Date() } }));
  }
}
