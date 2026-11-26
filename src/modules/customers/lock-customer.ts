import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

// In its own file so services that CustomersService injects can lock a customer without importing
// customers.service.ts, which would make an import cycle Nest's constructor metadata can't resolve.

/**
 * Locks the customer row for the rest of the transaction, which serialises
 * changes to its people (one owner, one membership each). Row-level security
 * hides other workspaces' customers, so a foreign id is not found.
 */
export async function lockCustomer(tx: Prisma.TransactionClient, id: string): Promise<{ id: string; name: string }> {
  const rows = await tx.$queryRaw<{ id: string; name: string }[]>`SELECT id, name FROM customer WHERE id = ${id}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) {
    throw new NotFoundException('Customer not found');
  }
  return row;
}
