import { Injectable } from '@nestjs/common';
import { deriveKey, open, seal } from '../../common/crypto/sealed';
import { ConfigService } from '../../config/config.service';

/**
 * Seals the secret variables of a notification (invitation and reset links)
 * for the time between raising and sending (plan N2). A database dump shows
 * ciphertext; the key is derived from APP_SECRET and never stored.
 */
@Injectable()
export class NotificationSecrets {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = deriveKey(config.get('APP_SECRET'), 'notification-secrets');
  }

  seal(values: Record<string, string>): Uint8Array<ArrayBuffer> {
    return new Uint8Array(seal(JSON.stringify(values), this.key));
  }

  open(sealed: Uint8Array): Record<string, string> {
    return JSON.parse(open(Buffer.from(sealed), this.key)) as Record<string, string>;
  }
}
