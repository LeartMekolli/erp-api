import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { ProductsService } from '../catalog/products.service';
import type { ProductForCheck } from '../catalog/products.service';
import type { Sizing } from '../catalog/scaling';
import type { CustomerAuth } from '../identity/auth-context';
import type { PortalProduct } from './customer-response';

/**
 * The products a customer may see and quote (Customers spec, goals 7 and 11):
 * published shared products, and its own published private products.
 */
export function visibleTo(customerId: string): Prisma.ProductWhereInput {
  return { status: 'active', published: true, OR: [{ customerId: null }, { customerId }] };
}

const portalInclude = {
  fileVersion: { select: { id: true } },
  optionGroups: {
    orderBy: { position: 'asc' },
    include: { group: { select: { key: true, name: true } }, defaultValue: { select: { key: true } } },
  },
  optionValues: {
    orderBy: { valueId: 'asc' },
    include: { value: { select: { groupId: true, key: true, name: true } } },
  },
} satisfies Prisma.ProductInclude;
type PortalRow = Prisma.ProductGetPayload<{ include: typeof portalInclude }>;

function toPortalProduct(row: PortalRow): PortalProduct {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as PortalProduct['kind'],
    private: row.customerId !== null,
    sizing: row.sizing as Sizing,
    options: row.optionGroups.map((group) => ({
      key: group.group.key,
      name: group.group.name,
      required: group.required,
      default: group.defaultValue?.key ?? null,
      values: row.optionValues
        .filter((offer) => offer.value.groupId === group.groupId)
        .map((offer) => ({ key: offer.value.key, name: offer.value.name })),
    })),
    design_file: row.fileVersion ? { version_id: row.fileVersion.id } : null,
  };
}

@Injectable()
export class PortalCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
  ) {}

  async list(customer: CustomerAuth): Promise<{ data: PortalProduct[] }> {
    const rows = await this.prisma.inTenant(customer.tenantId, (tx) =>
      tx.product.findMany({
        where: visibleTo(customer.customerId),
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        include: portalInclude,
      }),
    );
    return { data: rows.map(toPortalProduct) };
  }

  /** A product the customer may quote, for the configuration check; any other is not found. */
  async findVisible(tx: Prisma.TransactionClient, customerId: string, productId: string): Promise<ProductForCheck> {
    const visible = await tx.product.findFirst({ where: { id: productId, ...visibleTo(customerId) }, select: { id: true } });
    if (!visible) {
      throw new NotFoundException('Product not found');
    }
    return this.products.loadForCheck(tx, productId);
  }
}
