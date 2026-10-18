import { ConflictException, Injectable } from '@nestjs/common';
import { newId } from '../../common/ids/uuid';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { RedisService } from '../../redis/redis.service';

/** A completed response stays in Redis this long; Postgres keeps it 30 days. */
const CACHE_SECONDS = 24 * 60 * 60;

/** An in-progress key older than this belongs to a request that died. */
const ABANDONED_AFTER_SECONDS = 60;

export const KEY_REUSED = 'Idempotency key reused with a different request';
export const KEY_IN_PROGRESS = 'A request with this key is in progress';

export type Begin = { kind: 'proceed' } | { kind: 'replay'; status: number; body: unknown };

interface Stored {
  fingerprint: string;
  status: number;
  body: unknown;
}

/**
 * The idempotency store (ADR 0005.2): one row per tenant and key, holding the
 * request's fingerprint and, once it succeeded, its response. Redis fronts
 * completed responses so a burst of retries does not reach Postgres.
 */
@Injectable()
export class IdempotencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Claims the key for this request, or says what to replay. Throws 409 on a conflict. */
  async begin(tenantId: string, key: string, fingerprint: string): Promise<Begin> {
    const cached = await this.redis.client.get(cacheKey(tenantId, key));
    if (cached) {
      return replayOf(JSON.parse(cached) as Stored, fingerprint);
    }

    const result = await this.prisma.inTenant(tenantId, async (tx): Promise<Begin | Stored> => {
      // Only one of two concurrent requests inserts; the other finds the row.
      const inserted = await tx.$executeRaw`
        INSERT INTO idempotency_key (id, key, fingerprint, status, created_at)
        VALUES (${newId()}::uuid, ${key}, ${fingerprint}, 'in_progress', now())
        ON CONFLICT (tenant_id, key) DO NOTHING`;
      if (inserted === 1) {
        return { kind: 'proceed' };
      }

      const row = await tx.idempotencyKey.findFirst({ where: { key } });
      if (!row) {
        // Released by a failing request between the insert and this read.
        throw new ConflictException(KEY_IN_PROGRESS);
      }
      if (row.fingerprint !== fingerprint) {
        throw new ConflictException(KEY_REUSED);
      }
      if (row.status === 'completed') {
        return { fingerprint: row.fingerprint, status: row.responseStatus ?? 200, body: row.responseBody };
      }

      const reclaimed = await tx.$executeRaw`
        UPDATE idempotency_key SET created_at = now()
        WHERE id = ${row.id}::uuid AND status = 'in_progress'
          AND created_at < now() - (${ABANDONED_AFTER_SECONDS} * interval '1 second')`;
      if (reclaimed === 1) {
        return { kind: 'proceed' };
      }
      throw new ConflictException(KEY_IN_PROGRESS);
    });

    if ('kind' in result) {
      return result;
    }
    await this.cache(tenantId, key, result);
    return replayOf(result, fingerprint);
  }

  /** Stores a successful response against the key. */
  async complete(tenantId: string, key: string, fingerprint: string, status: number, body: unknown): Promise<void> {
    // The client received JSON; store and replay exactly that.
    const json: unknown = body === undefined ? null : JSON.parse(JSON.stringify(body));

    await this.prisma.inTenant(tenantId, (tx) =>
      tx.idempotencyKey.updateMany({
        where: { key, status: 'in_progress' },
        data: {
          status: 'completed',
          responseStatus: status,
          responseBody: json === null ? Prisma.DbNull : (json as Prisma.InputJsonValue),
          completedAt: new Date(),
        },
      }),
    );
    await this.cache(tenantId, key, { fingerprint, status, body: json });
  }

  /** Frees the key after a failed request, so the client can retry it. */
  async release(tenantId: string, key: string): Promise<void> {
    await this.prisma.inTenant(tenantId, (tx) =>
      tx.idempotencyKey.deleteMany({ where: { key, status: 'in_progress' } }),
    );
  }

  /** Deletes keys older than `days` in every tenant (J6); returns how many. */
  async deleteOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    let deleted = 0;

    for (const { id } of tenants) {
      const { count } = await this.prisma.inTenant(id, (tx) =>
        tx.idempotencyKey.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      );
      deleted += count;
    }
    return deleted;
  }

  private async cache(tenantId: string, key: string, stored: Stored): Promise<void> {
    await this.redis.client.set(cacheKey(tenantId, key), JSON.stringify(stored), 'EX', CACHE_SECONDS);
  }
}

function cacheKey(tenantId: string, key: string): string {
  return `idempotency:${tenantId}:${key}`;
}

function replayOf(stored: Stored, fingerprint: string): Begin {
  if (stored.fingerprint !== fingerprint) {
    throw new ConflictException(KEY_REUSED);
  }
  return { kind: 'replay', status: stored.status, body: stored.body };
}
