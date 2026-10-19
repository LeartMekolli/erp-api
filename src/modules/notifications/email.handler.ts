import { Inject, Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { HandlesJob, JobContext, JobHandler } from '../../jobs/handles-job';
import { SettingsService } from '../settings/settings.service';
import { EventKey, isEventKey, urlVariablesOf, variablesOf } from './catalogue';
import { MAILER } from './mailer';
import type { Mailer, MailMessage } from './mailer';
import { NotificationSecrets } from './notification-secrets';
import { renderTemplate } from './render';
import { TemplatesService } from './templates.service';

interface EmailPayload {
  tenantId: string;
  notificationId: string;
  to: string;
  locale: string;
  userId?: string;
}

const ERROR_LENGTH = 500;

function responseCodeOf(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { responseCode?: unknown }).responseCode : undefined;
  return typeof code === 'number' ? ` (mail server answered ${code})` : '';
}

function hasSecrets(event: EventKey): boolean {
  return Object.values(variablesOf(event)).some((spec) => spec.secret);
}

/**
 * Sends one notification to one address. Every attempt is appended to the
 * delivery log (ADR 0003). A notification already sent to this address is
 * not sent again, so a retry after a crash does not double the email.
 */
@Injectable()
@HandlesJob('notification.email')
export class EmailHandler implements JobHandler<EmailPayload> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly templates: TemplatesService,
    private readonly secrets: NotificationSecrets,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async handle(payload: EmailPayload, ctx: JobContext): Promise<void> {
    const { tenantId, notificationId, to } = payload;
    const prepared = await this.prisma.inTenant(tenantId, (tx) => this.prepare(tx, payload));
    if (!prepared) {
      return;
    }

    // Outside any transaction: a slow mail server must not hold a database connection.
    let providerId: string;
    try {
      ({ providerId } = await this.mailer.send({ ...prepared.message, to }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.inTenant(tenantId, (tx) =>
        tx.notificationDelivery.create({
          data: {
            notificationId,
            channel: 'email',
            target: to,
            status: 'failed',
            attempt: ctx.attempt,
            error: message.slice(0, ERROR_LENGTH),
          },
        }),
      );
      // Mail servers quote the recipient in their rejections. The delivery
      // log above already holds the address; what travels on to the worker's
      // log and the error reporter carries the status code only (spec 1.4).
      throw new Error(`Email could not be sent${responseCodeOf(error)}`);
    }

    await this.prisma.inTenant(tenantId, async (tx) => {
      await tx.notificationDelivery.create({
        data: { notificationId, channel: 'email', target: to, status: 'sent', attempt: ctx.attempt, providerId },
      });
      // Secret events have one target, so once sent the link is no longer needed (plan N2).
      if (prepared.wipeSecrets) {
        await tx.notification.update({ where: { id: notificationId }, data: { secrets: null } });
      }
    });
  }

  /** The link is useless once the email is given up on; drop it rather than keep it at rest. */
  async onDeadLetter({ tenantId, notificationId }: EmailPayload): Promise<void> {
    await this.prisma.inTenant(tenantId, (tx) =>
      tx.notification.updateMany({ where: { id: notificationId }, data: { secrets: null } }),
    );
  }

  private async prepare(
    tx: Prisma.TransactionClient,
    { notificationId, to, locale }: EmailPayload,
  ): Promise<{ message: Omit<MailMessage, 'to'>; wipeSecrets: boolean } | null> {
    const sent = await tx.notificationDelivery.findFirst({ where: { notificationId, target: to, status: 'sent' } });
    if (sent) {
      return null;
    }

    const notification = await tx.notification.findUniqueOrThrow({ where: { id: notificationId } });
    if (!isEventKey(notification.eventKey)) {
      throw new UnrecoverableError(`Unknown notification event ${notification.eventKey}`);
    }
    const event = notification.eventKey;

    const secretEvent = hasSecrets(event);
    let secretValues: Record<string, string> = {};
    if (secretEvent) {
      if (!notification.secrets) {
        throw new UnrecoverableError('Notification secrets are no longer available');
      }
      secretValues = this.secrets.open(notification.secrets);
    }

    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: notification.tenantId } });
    const template = await this.templates.forRecipient(tx, event, [locale, tenant.defaultLocale]);
    const variables = { ...(notification.payload as Record<string, string>), ...secretValues };
    const rendered = renderTemplate(template, variables, urlVariablesOf(event));

    const sender = (await this.settings.list(tx))['notification.sender'] as { name: string; email: string } | undefined;

    return {
      message: {
        from: sender ? { name: sender.name, address: sender.email } : this.config.get('MAIL_FROM'),
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      },
      wipeSecrets: secretEvent,
    };
  }
}
