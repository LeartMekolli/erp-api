import type {
  CustomerInvitationNotice,
  IdentityNotifier,
  InvitationNotice,
  PartnerInvitationNotice,
  PasswordResetNotice,
} from '../src/modules/identity/identity-notifier';

/** Stands in for email in tests: records what would have been sent. */
export class CapturingIdentityNotifier implements IdentityNotifier {
  readonly invitations: InvitationNotice[] = [];
  readonly passwordResets: PasswordResetNotice[] = [];
  readonly customerInvitations: CustomerInvitationNotice[] = [];
  readonly partnerInvitations: PartnerInvitationNotice[] = [];

  invitationCreated(notice: InvitationNotice): Promise<void> {
    this.invitations.push(notice);
    return Promise.resolve();
  }

  passwordResetRequested(notice: PasswordResetNotice): Promise<void> {
    this.passwordResets.push(notice);
    return Promise.resolve();
  }

  customerInvitationCreated(notice: CustomerInvitationNotice): Promise<void> {
    this.customerInvitations.push(notice);
    return Promise.resolve();
  }

  partnerInvitationCreated(notice: PartnerInvitationNotice): Promise<void> {
    this.partnerInvitations.push(notice);
    return Promise.resolve();
  }

  lastPartnerInvitationFor(email: string): PartnerInvitationNotice | undefined {
    return this.partnerInvitations.filter((notice) => notice.email === email).at(-1);
  }

  lastCustomerInvitationFor(email: string): CustomerInvitationNotice | undefined {
    return this.customerInvitations.filter((notice) => notice.email === email).at(-1);
  }

  lastInvitationFor(email: string): InvitationNotice | undefined {
    return this.invitations.filter((notice) => notice.email === email).at(-1);
  }

  lastPasswordResetFor(email: string): PasswordResetNotice | undefined {
    return this.passwordResets.filter((notice) => notice.email === email).at(-1);
  }
}
