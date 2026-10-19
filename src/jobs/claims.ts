import { Prisma } from '../generated/prisma/client';

/**
 * Tables whose rows are worked on by claiming them (rule A1). Each needs
 * `status` and `claimed_at` columns. Later modules extend the union.
 */
export type ClaimableTable = 'notification' | 'file_version';

const CLAIMABLE_TABLES: ReadonlySet<string> = new Set<ClaimableTable>(['notification', 'file_version']);

/** The table name is interpolated as SQL, so it must come from the union, never from input. */
export function claimableTableSql(table: ClaimableTable): Prisma.Sql {
  if (!CLAIMABLE_TABLES.has(table)) {
    throw new Error(`Not a claimable table: ${String(table)}`);
  }
  return Prisma.raw(table);
}

/**
 * Claims a row with one conditional update: of two concurrent runs, exactly
 * one sees `true`. The claim records when it started, so the sweeper can
 * recover it if the runner dies.
 */
export async function claimRow(
  tx: Prisma.TransactionClient,
  table: ClaimableTable,
  id: string,
  from: readonly string[],
  to: string,
): Promise<boolean> {
  const count = await tx.$executeRaw`
    UPDATE ${claimableTableSql(table)} SET status = ${to}, claimed_at = now()
    WHERE id = ${id}::uuid AND status = ANY(${[...from]}::text[])`;
  return count === 1;
}

/** Hands a claimed row back, so a retry can claim it again. */
export async function releaseRow(
  tx: Prisma.TransactionClient,
  table: ClaimableTable,
  id: string,
  claimed: string,
  pending: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE ${claimableTableSql(table)} SET status = ${pending}, claimed_at = NULL
    WHERE id = ${id}::uuid AND status = ${claimed}`;
}
