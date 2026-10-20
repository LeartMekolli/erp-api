import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import type { Prisma } from '../generated/prisma/client';
import { ConfigService } from '../config/config.service';

const poolLogger = new Logger('DatabasePool');

/**
 * An idle pooled connection failed (the server closed it, as Neon does when its
 * compute suspends). The pool drops it and opens a new one on demand; this only
 * makes it visible. Without a handler of its own the pool would emit an
 * unhandled 'error' event and end the process, so the adapter always listens.
 */
export function logPoolError(error: Error): void {
  poolLogger.warn(`Idle database connection failed and was dropped: ${error.message}`);
}

/**
 * Prisma 7 has no built-in query engine: the client is constructed with a
 * driver adapter. The connection string is DATABASE_URL — the erp_app role,
 * which row-level security applies to. Migrations use the owner role through
 * prisma.config.ts instead (ADR 0001).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({ connectionString: config.get('DATABASE_URL') }, { onPoolError: logPoolError }),
    });
  }

  /**
   * The only way to touch tenant-owned tables. Runs `fn` in a transaction with
   * the tenant set as `app.current_tenant_id`, which row-level security reads
   * on every statement — Prisma queries and raw SQL alike. Outside this, the
   * same tables return no rows and refuse inserts.
   *
   * `set_config(..., true)` is transaction-local, which is what makes this safe
   * with a connection pool: the setting cannot leak to the next borrower.
   *
   * The transaction holds a pooled connection until `fn` settles, so keep
   * network calls and other slow work outside it.
   */
  async inTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
