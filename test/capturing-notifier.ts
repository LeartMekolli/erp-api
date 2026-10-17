import type {
  IdentityNotifier,
  InvitationNotice,
  PasswordResetNotice,
} from '../src/modules/identity/identity-notifier';

/** Stands in for email in tests: records what would have been sent. */
export class CapturingIdentityNotifier implements IdentityNotifier {
  readonly invitations: InvitationNotice[] = [];
  readonly passwordResets: PasswordResetNotice[] = [];

  invitationCreated(notice: InvitationNotice): Promise<void> {
    this.invitations.push(notice);
    return Promise.resolve();
  }

  passwordResetRequested(notice: PasswordResetNotice): Promise<void> {
    this.passwordResets.push(notice);
    return Promise.resolve();
  }

  lastInvitationFor(email: string): InvitationNotice | undefined {
    return this.invitations.filter((notice) => notice.email === email).at(-1);
  }

  lastPasswordResetFor(email: string): PasswordResetNotice | undefined {
    return this.passwordResets.filter((notice) => notice.email === email).at(-1);
  }
}
