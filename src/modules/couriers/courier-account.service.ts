import { ConflictException, Injectable } from '@nestjs/common';
import { deriveKey, open, seal } from '../../common/crypto/sealed';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditInput } from '../audit/audit.service';
import type { Address } from '../orders/order-response';
import type { CourierKeys } from './courier-provider';
import type { CourierAccountResponse, SetCourierAccount } from './courier-response';

export interface CourierAccountKeys {
  keys: CourierKeys;
  webhookSecret: string;
  fromAddress: Address;
}

/** Each workspace's own courier service key, sealed at rest like the payment keys (Orders 3 spec, goal 21). */
@Injectable()
export class CourierAccountService {
  private readonly key: Buffer;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    this.key = deriveKey(config.get('APP_SECRET'), 'courier-keys');
  }

  async view(tx: Prisma.TransactionClient, tenantId: string): Promise<CourierAccountResponse> {
    const row = await tx.courierAccount.findFirst();
    return {
      configured: row !== null,
      // EasyPost test keys start EZTK, production keys EZAK.
      mode: row ? (open(Buffer.from(row.apiKey), this.key).startsWith('EZTK') ? 'test' : 'live') : null,
      from_address: (row?.fromAddress as Address | undefined) ?? null,
      webhook_url: `/webhooks/couriers/${tenantId}`,
    };
  }

  /** Replaces the workspace's account, as staff or as the demo seed (the system). */
  async set(tx: Prisma.TransactionClient, tenantId: string, actor: AuditInput['actor'], input: SetCourierAccount): Promise<CourierAccountResponse> {
    const data = {
      apiKey: new Uint8Array(seal(input.api_key, this.key)),
      webhookSecret: new Uint8Array(seal(input.webhook_secret, this.key)),
      fromAddress: input.from_address,
    };
    const before = await tx.courierAccount.findFirst({ select: { fromAddress: true } });
    await tx.courierAccount.upsert({ where: { tenantId }, create: data, update: data });
    // No key or secret goes into the entry.
    await this.audit.record(tx, {
      actor,
      action: 'workspace.courier_account_changed',
      subject: { type: 'courier_account', id: tenantId },
      before: { configured: before !== null, from_address: (before?.fromAddress as Prisma.InputJsonValue | undefined) ?? null },
      after: { configured: true, from_address: input.from_address },
    });
    return this.view(tx, tenantId);
  }

  /** The account, or null when the workspace has none. */
  async find(tx: Prisma.TransactionClient): Promise<CourierAccountKeys | null> {
    const row = await tx.courierAccount.findFirst();
    if (!row) return null;
    return {
      keys: { apiKey: open(Buffer.from(row.apiKey), this.key) },
      webhookSecret: open(Buffer.from(row.webhookSecret), this.key),
      fromAddress: row.fromAddress as Address,
    };
  }

  /** For a request that holds a transaction. 409 when the workspace has no account. */
  async keys(tx: Prisma.TransactionClient): Promise<CourierAccountKeys> {
    const account = await this.find(tx);
    if (!account) throw new ConflictException('No courier service is set up for this workspace');
    return account;
  }

  /** For work outside a transaction (rates, labels, webhooks). */
  findFor(tenantId: string): Promise<CourierAccountKeys | null> {
    return this.prisma.inTenant(tenantId, (tx) => this.find(tx));
  }
}
