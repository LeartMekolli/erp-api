import { Injectable } from '@nestjs/common';
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
import { identityLink } from './web-links';

interface TenantLinkInfo {
  name: string;
  slug: string;
  customerSiteOrigin: string | null;
}

/**
 * Identity emails as notifications. The link is built here from the tenant's
 * slug, its customer site and the configured web URL, never from anything a
 * caller sent (D78), and travels as a secret variable, sealed until sent
 * (plan N2).
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
      link: this.link(tenant, false, '/accept-invitation', notice.token),
    });
  }

  async passwordResetRequested(notice: PasswordResetNotice): Promise<void> {
    const tenant = await this.tenant(notice.tenantId);
    const user = await this.prisma.inTenant(notice.tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: notice.userId }, select: { name: true, kind: true } }),
    );
    await this.notifications.raise(notice.tenantId, 'auth.password_reset_requested', { type: 'user', id: notice.userId }, {
      tenant_name: tenant.name,
      user_name: user.name,
      link: this.link(tenant, user.kind === 'customer', '/reset-password', notice.token),
    });
  }

  async customerInvitationCreated(notice: CustomerInvitationNotice): Promise<void> {
    const tenant = await this.tenant(notice.tenantId);
    await this.notifications.raise(
      notice.tenantId,
      'customer.invited',
      { type: 'customer_invitation', id: notice.invitationId },
      {
        tenant_name: tenant.name,
        customer_name: notice.customerName,
        link: this.link(tenant, true, '/accept-invitation', notice.token),
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
        link: this.link(tenant, false, '/accept-invitation', notice.token),
      },
    );
  }

  private link(
    tenant: TenantLinkInfo,
    forCustomer: boolean,
    path: '/accept-invitation' | '/reset-password',
    token: string,
  ): string {
    return identityLink(
      { webTemplate: this.config.get('WEB_URL_TEMPLATE'), slug: tenant.slug, customerSiteOrigin: tenant.customerSiteOrigin, forCustomer },
      path,
      token,
    );
  }

  /** The tenant table is platform-owned, so no tenant scope is needed to read it. */
  private tenant(id: string): Promise<TenantLinkInfo> {
    return this.prisma.tenant.findUniqueOrThrow({
      where: { id },
      select: { name: true, slug: true, customerSiteOrigin: true },
    });
  }
}
