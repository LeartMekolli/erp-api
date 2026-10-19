import { Module } from '@nestjs/common';
import { NotificationIdentityNotifier } from '../notifications/notification-identity-notifier';
import { NotificationsModule } from '../notifications/notifications.module';

export interface InvitationNotice {
  tenantId: string;
  invitationId: string;
  email: string;
  token: string;
}

export interface PasswordResetNotice {
  tenantId: string;
  userId: string;
  email: string;
  token: string;
}

/**
 * How identity emails leave the system (plan 2, P8). Callers say what
 * happened; they never choose a recipient address, template or link (D68,
 * D78). Called only after the transaction that created the token has
 * committed. Bound to the notification service; tests swap in a capturing
 * stand-in.
 */
export interface IdentityNotifier {
  invitationCreated(notice: InvitationNotice): Promise<void>;
  passwordResetRequested(notice: PasswordResetNotice): Promise<void>;
}

export const IDENTITY_NOTIFIER = Symbol('IDENTITY_NOTIFIER');

@Module({
  imports: [NotificationsModule],
  providers: [{ provide: IDENTITY_NOTIFIER, useClass: NotificationIdentityNotifier }],
  exports: [IDENTITY_NOTIFIER],
})
export class IdentityNotifierModule {}
