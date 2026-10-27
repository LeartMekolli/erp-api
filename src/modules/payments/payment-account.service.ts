import { ConflictException, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { deriveKey, open, seal } from '../../common/crypto/sealed';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import type { ProviderKeys } from './payment-provider';
import type { PaymentAccountResponse, setPaymentAccountSchema } from './payment-response';

export interface AccountKeys {
  keys: ProviderKeys;
  webhookSecret: string;
  connectWebhookSecret: string;
}

/** Each workspace's own provider keys, sealed at rest (Payments spec, D86). */
@Injectable()
export class PaymentAccountService {
  private readonly key: Buffer;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    this.key = deriveKey(config.get('APP_SECRET'), 'payment-keys');
  }

  async view(tx: Prisma.TransactionClient, tenantId: string): Promise<PaymentAccountResponse> {
    const row = await tx.paymentAccount.findFirst();
    return {
      configured: row !== null,
      publishable_key: row?.publishableKey ?? null,
      mode: row ? (open(Buffer.from(row.secretKey), this.key).includes('_live_') ? 'live' : 'test') : null,
      webhook_urls: {
        payments: `/webhooks/payments/${tenantId}`,
        connect: `/webhooks/payments/${tenantId}/connect`,
      },
    };
  }

  async set(
    tx: Prisma.TransactionClient,
    auth: TenantAuth,
    input: z.infer<typeof setPaymentAccountSchema>,
  ): Promise<PaymentAccountResponse> {
    const data = {
      secretKey: new Uint8Array(seal(input.secret_key, this.key)),
      webhookSecret: new Uint8Array(seal(input.webhook_secret, this.key)),
      connectWebhookSecret: new Uint8Array(seal(input.connect_webhook_secret, this.key)),
      publishableKey: input.publishable_key,
    };
    const before = await tx.paymentAccount.findFirst({ select: { publishableKey: true } });
    await tx.paymentAccount.upsert({ where: { tenantId: auth.tenantId }, create: data, update: data });
    // No key, secret or signing secret goes into the entry.
    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'payment.account.changed',
      subject: { type: 'payment_account', id: auth.tenantId },
      before: { configured: before !== null },
      after: { configured: true, publishable_key: input.publishable_key },
    });
    return this.view(tx, auth.tenantId);
  }

  /** For a request that holds a transaction. 409 when the workspace has no keys. */
  async keys(tx: Prisma.TransactionClient): Promise<AccountKeys> {
    const keys = await this.find(tx);
    if (!keys) throw new ConflictException('Payments are not set up for this workspace');
    return keys;
  }

  /** The keys, or null when the workspace has none. */
  async find(tx: Prisma.TransactionClient): Promise<AccountKeys | null> {
    const row = await tx.paymentAccount.findFirst();
    return row ? this.unseal(row) : null;
  }

  /** For jobs and webhooks, which have no transaction yet. */
  keysFor(tenantId: string): Promise<AccountKeys> {
    return this.prisma.inTenant(tenantId, (tx) => this.keys(tx));
  }

  private unseal(row: { secretKey: Uint8Array; webhookSecret: Uint8Array; connectWebhookSecret: Uint8Array }): AccountKeys {
    return {
      keys: { secretKey: open(Buffer.from(row.secretKey), this.key) },
      webhookSecret: open(Buffer.from(row.webhookSecret), this.key),
      connectWebhookSecret: open(Buffer.from(row.connectWebhookSecret), this.key),
    };
  }
}
