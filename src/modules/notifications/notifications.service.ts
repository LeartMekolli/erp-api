import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { JobsService } from '../../jobs/jobs.service';
import { EVENTS, EventKey, EventVariables, variablesOf } from './catalogue';
import { NotificationSecrets } from './notification-secrets';

/**
 * The one way domain code sends anything (D68): say what happened, about
 * what, with which values. Who receives it, the wording and the channels are
 * decided by the catalogue, the tenant's templates and the worker.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly secrets: NotificationSecrets,
  ) {}

  /**
   * Stores the notification, then queues its dispatch. Call it after the
   * change it describes has committed (plan N3). If queueing fails, the row
   * stays pending and the claim sweeper queues it within a minute, so this
   * only throws when the row itself could not be written.
   */
  async raise<E extends EventKey>(
    tenantId: string,
    event: E,
    subject: { type: string; id: string },
    variables: EventVariables<E>,
  ): Promise<string> {
    const values = variables as Record<string, string>;
    const plain: Record<string, string> = {};
    const secret: Record<string, string> = {};

    for (const [name, spec] of Object.entries(variablesOf(event))) {
      const value = values[name];
      if (value === undefined) {
        throw new Error(`Notification ${event} is missing variable ${name}`);
      }
      (spec.secret ? secret : plain)[name] = value;
    }

    const notification = await this.prisma.inTenant(tenantId, (tx) =>
      tx.notification.create({
        data: {
          eventKey: event,
          audience: EVENTS[event].audience.kind,
          subjectType: subject.type,
          subjectId: subject.id,
          payload: plain,
          secrets: Object.keys(secret).length > 0 ? this.secrets.seal(secret) : null,
          status: 'pending',
        },
      }),
    );

    try {
      await this.jobs.enqueue('notification.dispatch', { tenantId, notificationId: notification.id });
    } catch (error) {
      this.logger.warn(
        `Could not queue notification ${notification.id}; the sweeper will retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return notification.id;
  }
}
