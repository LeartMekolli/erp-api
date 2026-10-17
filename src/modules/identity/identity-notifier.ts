import { Injectable, Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';

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
 * D78). Plan 3 binds this to the notification service. Called only after the
 * transaction that created the token has committed.
 */
export interface IdentityNotifier {
  invitationCreated(notice: InvitationNotice): Promise<void>;
  passwordResetRequested(notice: PasswordResetNotice): Promise<void>;
}

export const IDENTITY_NOTIFIER = Symbol('IDENTITY_NOTIFIER');

/**
 * Development stand-in until plan 3: prints the token to stdout so a developer
 * can accept an invitation locally. Deliberately not the logger, which must
 * never carry tokens.
 */
@Injectable()
export class ConsoleIdentityNotifier implements IdentityNotifier {
  invitationCreated(notice: InvitationNotice): Promise<void> {
    process.stdout.write(`[dev email] invitation for ${notice.email}: ${notice.token}\n`);
    return Promise.resolve();
  }

  passwordResetRequested(notice: PasswordResetNotice): Promise<void> {
    process.stdout.write(`[dev email] password reset for ${notice.email}: ${notice.token}\n`);
    return Promise.resolve();
  }
}

@Module({
  providers: [
    {
      provide: IDENTITY_NOTIFIER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): IdentityNotifier => {
        if (config.get('NODE_ENV') === 'production') {
          throw new Error('No identity notifier is bound for production; plan 3 binds the notification service.');
        }
        return new ConsoleIdentityNotifier();
      },
    },
  ],
  exports: [IDENTITY_NOTIFIER],
})
export class IdentityNotifierModule {}
