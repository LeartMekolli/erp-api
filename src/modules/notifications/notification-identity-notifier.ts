import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { IdentityNotifier, InvitationNotice, PasswordResetNotice } from '../identity/identity-notifier';
import { NotificationsService } from './notifications.service';
import { webLink } from './web-links';

/**
 * Identity emails as notifications. The link is built here from the tenant's
 * slug and the configured web URL, never from anything a caller sent (D78),
 * and travels as a secret variable, sealed until sent (plan N2).
 */
@Injectable()
export class NotificationIdentityNotifier implements IdentityNotifier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  async invitationCreated(notice: InvitationNotice): Promise<void> {
    const tenant = await this.tenant(notice.tenantId);
    await this.notifications.raise(notice.tenantId, 'user.invited', { type: 'invitation', id: notice.invitationId }, {
      tenant_name: tenant.name,
      link: webLink(this.config.get('WEB_URL_TEMPLATE'), tenant.slug, '/accept-invitation', notice.token),
    });
  }

  async passwordResetRequested(notice: PasswordResetNotice): Promise<void> {
    const tenant = await this.tenant(notice.tenantId);
    const user = await this.prisma.inTenant(notice.tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: notice.userId }, select: { name: true } }),
    );
    await this.notifications.raise(notice.tenantId, 'auth.password_reset_requested', { type: 'user', id: notice.userId }, {
      tenant_name: tenant.name,
      user_name: user.name,
      link: webLink(this.config.get('WEB_URL_TEMPLATE'), tenant.slug, '/reset-password', notice.token),
    });
  }

  /** The tenant table is platform-owned, so no tenant scope is needed to read it. */
  private tenant(id: string): Promise<{ name: string; slug: string }> {
    return this.prisma.tenant.findUniqueOrThrow({ where: { id }, select: { name: true, slug: true } });
  }
}
