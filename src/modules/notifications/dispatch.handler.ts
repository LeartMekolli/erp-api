import { Injectable, OnModuleInit } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { claimRow, releaseRow } from '../../jobs/claims';
import { ClaimSweeper } from '../../jobs/claim-sweeper';
import { HandlesJob, JobHandler } from '../../jobs/handles-job';
import { JobsService } from '../../jobs/jobs.service';
import { SettingsService } from '../settings/settings.service';
import { resolveAudience, Target } from './audience';
import { EVENTS, isEventKey, urlVariablesOf } from './catalogue';
import { renderTemplate } from './render';
import { TemplatesService } from './templates.service';

interface DispatchPayload {
  tenantId: string;
  notificationId: string;
}

/**
 * Fans one notification out (D72): claims it (rule A1), resolves who it
 * reaches, writes their feed entries, and queues one email per address.
 * Every step is safe to repeat: feed rows are unique per user and email jobs
 * are keyed by address, so a retry never doubles anything.
 */
@Injectable()
@HandlesJob('notification.dispatch')
export class DispatchHandler implements JobHandler<DispatchPayload>, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly sweeper: ClaimSweeper,
    private readonly settings: SettingsService,
    private readonly templates: TemplatesService,
  ) {}

  /** Pending notifications whose job was lost, and claims whose runner died, are queued again. */
  onModuleInit(): void {
    this.sweeper.register({
      table: 'notification',
      pending: 'pending',
      claimed: 'dispatching',
      lostAfterMs: 60_000,
      staleAfterMs: 300_000,
      requeue: (tenantId, notificationId) => this.jobs.enqueue('notification.dispatch', { tenantId, notificationId }),
    });
  }

  async handle({ tenantId, notificationId }: DispatchPayload): Promise<void> {
    // 'failed' is claimable too, so a platform admin's retry of a dead letter works.
    const claimed = await this.prisma.inTenant(tenantId, (tx) =>
      claimRow(tx, 'notification', notificationId, ['pending', 'failed'], 'dispatching'),
    );
    if (!claimed) {
      return;
    }

    try {
      const emailTargets = await this.prisma.inTenant(tenantId, (tx) => this.fanOut(tx, notificationId));

      for (const target of emailTargets) {
        await this.jobs.enqueue('notification.email', {
          tenantId,
          notificationId,
          to: target.email,
          locale: target.locale,
          userId: target.userId,
        });
      }

      await this.prisma.inTenant(tenantId, (tx) =>
        tx.notification.updateMany({
          where: { id: notificationId, status: 'dispatching' },
          data: { status: 'dispatched' },
        }),
      );
    } catch (error) {
      // Hand the claim back, or the retry would find it taken and skip the
      // notification for good (Review Focus 1).
      await this.prisma.inTenant(tenantId, (tx) =>
        releaseRow(tx, 'notification', notificationId, 'dispatching', 'pending'),
      );
      throw error;
    }
  }

  async onDeadLetter({ tenantId, notificationId }: DispatchPayload): Promise<void> {
    await this.prisma.inTenant(tenantId, (tx) =>
      tx.notification.updateMany({ where: { id: notificationId }, data: { status: 'failed', claimedAt: null } }),
    );
  }

  /** Writes the feed and returns who gets an email. */
  private async fanOut(tx: Prisma.TransactionClient, notificationId: string): Promise<Target[]> {
    const notification = await tx.notification.findUniqueOrThrow({ where: { id: notificationId } });
    if (!isEventKey(notification.eventKey)) {
      throw new UnrecoverableError(`Unknown notification event ${notification.eventKey}`);
    }
    const event = notification.eventKey;
    const channels: readonly string[] = EVENTS[event].channels;
    const targets = await resolveAudience(tx, notification, this.settings);

    if (channels.includes('feed')) {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: notification.tenantId } });
      const variables = notification.payload as Record<string, string>;
      const rows = [];
      for (const target of targets) {
        if (!target.userId) {
          continue;
        }
        const template = await this.templates.forRecipient(tx, event, [target.locale, tenant.defaultLocale]);
        const rendered = renderTemplate(template, variables, urlVariablesOf(event));
        rows.push({ notificationId, userId: target.userId, title: rendered.subject, body: rendered.text });
      }
      await tx.notificationRecipient.createMany({ data: rows, skipDuplicates: true });
    }

    return channels.includes('email') ? targets : [];
  }
}
