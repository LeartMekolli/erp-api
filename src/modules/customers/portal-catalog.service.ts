import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { ProductsService } from '../catalog/products.service';
import type { Sizing } from '../catalog/scaling';
import { visibleTo } from '../catalog/visibility';
import type { CustomerAuth } from '../identity/auth-context';
import type { PortalProduct } from './customer-response';

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
  parts: { orderBy: { position: 'asc' }, include: { part: { select: { name: true } } } },
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
    parts: row.parts.map((part) => ({ name: part.part.name, quantity: part.quantity })),
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

  /** Saves one of the customer's quotes as its own product, published to it at once. */
  async saveQuote(customer: CustomerAuth, input: { quoteId: string; name: string }): Promise<PortalProduct> {
    return this.prisma.inTenant(customer.tenantId, async (tx) => {
      const id = await this.products.createPrivateFromQuote(tx, { customerId: customer.customerId, ...input });
      return toPortalProduct(await tx.product.findUniqueOrThrow({ where: { id }, include: portalInclude }));
    });
  }
}
