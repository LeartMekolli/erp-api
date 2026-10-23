import type { Prisma } from '../../generated/prisma/client';

/**
 * The products a customer may see and quote (Customers spec, goals 7 and 11):
 * published shared products, and its own published private products.
 */
export function visibleTo(customerId: string): Prisma.ProductWhereInput {
  return { status: 'active', published: true, OR: [{ customerId: null }, { customerId }] };
}
