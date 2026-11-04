import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type {
  CustomerInvitationNotice,
  IdentityNotifier,
  InvitationNotice,
  PartnerInvitationNotice,
  PasswordResetNotice,
} from '../identity/identity-notifier';
import { NotificationsService } from './notifications.service';
import { identityLink, webLink } from './web-links';

interface TenantLinkInfo {
  name: string;
  slug: string;
  customerSiteOrigin: string | null;
}

/**
 * Identity emails as notifications. The link is built here from the tenant's
 * slug, its customer site and the configured web URL, never from anything a
 * caller sent (D78), and travels as a secret variable, sealed until sent
 * (plan N2). A customer person's email needs the workspace's customer site;
 * without one it is skipped with a warning, never sent into the staff app.
 */
@Injectable()
export class NotificationIdentityNotifier implements IdentityNotifier {
  private readonly logger = new Logger(NotificationIdentityNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  async invitationCreated(notice: InvitationNotice): Promise<void> {
    const tenant = await this.tenant(notice.tenantId);
    await this.notifications.raise(notice.tenantId, 'user.invited', { type: 'invitation', id: notice.invitationId }, {
      tenant_name: tenant.name,
      link: this.staffLink(tenant, '/accept-invitation', notice.token),
    });
  }

  async passwordResetRequested(notice: PasswordResetNotice): Promise<void> {
    const tenant = await this.tenant(notice.tenantId);
    const user = await this.prisma.inTenant(notice.tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: notice.userId }, select: { name: true, kind: true } }),
    );
    const link =
      user.kind === 'customer'
        ? this.customerLink(tenant, '/reset-password', notice.token, `password reset for user ${notice.userId}`)
        : this.staffLink(tenant, '/reset-password', notice.token);
    if (!link) {
      return;
    }
    await this.notifications.raise(notice.tenantId, 'auth.password_reset_requested', { type: 'user', id: notice.userId }, {
      tenant_name: tenant.name,
      user_name: user.name,
      link,
    });
  }

  async customerInvitationCreated(notice: CustomerInvitationNotice): Promise<void> {
    const tenant = await this.tenant(notice.tenantId);
    const link = this.customerLink(tenant, '/accept-invitation', notice.token, `customer invitation ${notice.invitationId}`);
    if (!link) {
      return;
    }
    await this.notifications.raise(
      notice.tenantId,
      'customer.invited',
      { type: 'customer_invitation', id: notice.invitationId },
      {
        tenant_name: tenant.name,
        customer_name: notice.customerName,
        link,
      },
    );
  }

  /** Partner people work in the web app, as staff do, until a partner site exists. */
  async partnerInvitationCreated(notice: PartnerInvitationNotice): Promise<void> {
    const tenant = await this.tenant(notice.tenantId);
    await this.notifications.raise(
      notice.tenantId,
      'partner.invited',
      { type: 'partner_invitation', id: notice.invitationId },
      {
        tenant_name: tenant.name,
        partner_name: notice.partnerName,
        link: this.staffLink(tenant, '/accept-invitation', notice.token),
      },
    );
  }

  private staffLink(tenant: TenantLinkInfo, path: '/accept-invitation' | '/reset-password', token: string): string {
    return webLink(this.config.get('WEB_URL_TEMPLATE'), tenant.slug, path, token);
  }

  /** Null, with a warning naming what was skipped, when the workspace has no customer site. */
  private customerLink(
    tenant: TenantLinkInfo,
    path: '/accept-invitation' | '/reset-password',
    token: string,
    skipped: string,
  ): string | null {
    const link = identityLink(
      { webTemplate: this.config.get('WEB_URL_TEMPLATE'), slug: tenant.slug, customerSiteOrigin: tenant.customerSiteOrigin, forCustomer: true },
      path,
      token,
    );
    if (!link) {
      this.logger.warn(`Workspace ${tenant.slug} has no customer site, so the email for ${skipped} was not sent`);
    }
    return link;
  }

  /** The tenant table is platform-owned, so no tenant scope is needed to read it. */
  private tenant(id: string): Promise<TenantLinkInfo> {
    return this.prisma.tenant.findUniqueOrThrow({
      where: { id },
      select: { name: true, slug: true, customerSiteOrigin: true },
    });
  }
}
