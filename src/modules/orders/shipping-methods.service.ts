import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma, ShippingMethod } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { conflictOnDuplicate, keySchema } from '../pricing/decimals';
import type { ShippingMethodResponse } from './order-response';

/** Money in the workspace's currency: zero or more, at most cents. */
export const moneySchema = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'must be an amount with at most 2 places, such as 9.90');

const nameSchema = z.string().trim().min(1).max(200);

export const createShippingMethodSchema = z.object({
  key: keySchema,
  name: nameSchema,
  /** Per order. */
  price: moneySchema,
});
export const updateShippingMethodSchema = z.object({
  name: nameSchema.optional(),
  price: moneySchema.optional(),
  /** Switched off, it can't be chosen for new orders; past orders keep it. */
  active: z.boolean().optional(),
});

export function toShippingMethod(row: ShippingMethod): ShippingMethodResponse {
  return { id: row.id, key: row.key, name: row.name, price: row.price.toFixed(2), active: row.active };
}

/** The ways an order can reach the customer, each with its price (Orders spec, goal 9). */
@Injectable()
export class ShippingMethodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<ShippingMethodResponse[]> {
    return this.prisma.inTenant(tenantId, async (tx) =>
      (await tx.shippingMethod.findMany({ orderBy: { key: 'asc' } })).map(toShippingMethod),
    );
  }

  async create(auth: TenantAuth, input: z.infer<typeof createShippingMethodSchema>): Promise<ShippingMethodResponse> {
    try {
      return await this.prisma.inTenant(auth.tenantId, async (tx) => {
        const created = toShippingMethod(await tx.shippingMethod.create({ data: input }));
        await this.record(tx, auth, created.id, undefined, created);
        return created;
      });
    } catch (error) {
      conflictOnDuplicate(error, `A shipping method with key ${input.key} already exists`);
    }
  }

  async update(auth: TenantAuth, id: string, patch: z.infer<typeof updateShippingMethodSchema>): Promise<ShippingMethodResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      // Row-level security hides other workspaces' methods, so a foreign id is simply not found.
      const current = await tx.shippingMethod.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('Shipping method not found');
      }
      const updated = toShippingMethod(await tx.shippingMethod.update({ where: { id }, data: patch }));
      await this.record(tx, auth, id, toShippingMethod(current), updated);
      return updated;
    });
  }

  private record(
    tx: Prisma.TransactionClient,
    auth: TenantAuth,
    id: string,
    before: ShippingMethodResponse | undefined,
    after: ShippingMethodResponse,
  ): Promise<void> {
    return this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'pricing.changed',
      subject: { type: 'shipping_method', id },
      before,
      after,
    });
  }
}
