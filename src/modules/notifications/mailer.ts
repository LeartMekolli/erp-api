import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { ConfigService } from '../../config/config.service';

export const MAILER = Symbol('MAILER');

export interface MailMessage {
  /** An address, "Name <address>", or a name and address. */
  from: string | { name: string; address: string };
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** How email leaves the system (D88). The provider is configuration. */
export interface Mailer {
  send(message: MailMessage): Promise<{ providerId: string }>;
}

/**
 * Nodemailer over SMTP: Mailpit locally, Resend's SMTP endpoint in
 * production (plan N7). Only `SMTP_URL` differs between them.
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(config: ConfigService) {
    this.transport = createTransport(config.get('SMTP_URL'));
  }

  async send(message: MailMessage): Promise<{ providerId: string }> {
    const info = (await this.transport.sendMail(message)) as { messageId: string };
    return { providerId: info.messageId };
  }
}
