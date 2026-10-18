import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { HandlesJob, JobHandler } from './handles-job';
import { claimableTableSql } from './claims';
import type { ClaimableTable } from './claims';

/** A kind of claimed work the sweeper recovers. */
export interface Claimable {
  table: ClaimableTable;
  pending: string;
  claimed: string;
  /** A pending row this old has lost its job (the enqueue failed). */
  lostAfterMs: number;
  /** A claim this old belongs to a runner that died. */
  staleAfterMs: number;
  requeue(tenantId: string, id: string): Promise<void>;
}

/**
 * Recovers claimed work whose runner died, and pending work whose job was
 * never enqueued (rule A1). Iterates tenants, because row-level security
 * scopes every query to one (J6). Requeues after each tenant's transaction
 * commits, so a requeued job never sees a row still being reset.
 */
@Injectable()
export class ClaimSweeper {
  private readonly logger = new Logger(ClaimSweeper.name);
  private readonly claimables: Claimable[] = [];

  constructor(private readonly prisma: PrismaService) {}

  register(claimable: Claimable): void {
    this.claimables.push(claimable);
  }

  /** Returns how many rows were requeued. */
  async sweep(): Promise<number> {
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    let requeued = 0;

    for (const { id: tenantId } of tenants) {
      for (const claimable of this.claimables) {
        const ids = await this.prisma.inTenant(tenantId, (tx) => this.findWork(tx, claimable));

        for (const id of ids) {
          try {
            await claimable.requeue(tenantId, id);
            requeued += 1;
          } catch (error) {
            this.logger.error(
              `Could not requeue ${claimable.table} ${id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }

    return requeued;
  }

  private async findWork(tx: Prisma.TransactionClient, claimable: Claimable): Promise<string[]> {
    const table = claimableTableSql(claimable.table);

    const stale = await tx.$queryRaw<{ id: string }[]>`
      UPDATE ${table} SET status = ${claimable.pending}, claimed_at = NULL
      WHERE status = ${claimable.claimed}
        AND claimed_at < now() - (${claimable.staleAfterMs} * interval '1 millisecond')
      RETURNING id`;
    const lost = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM ${table}
      WHERE status = ${claimable.pending}
        AND created_at < now() - (${claimable.lostAfterMs} * interval '1 millisecond')`;

    return [...new Set([...stale, ...lost].map((row) => row.id))];
  }
}

/** Runs the sweep every minute (SCHEDULED_JOBS['claims.sweep']). */
@Injectable()
@HandlesJob('claims.sweep')
export class ClaimSweepHandler implements JobHandler<Record<string, never>> {
  constructor(private readonly sweeper: ClaimSweeper) {}

  async handle(): Promise<void> {
    await this.sweeper.sweep();
  }
}
