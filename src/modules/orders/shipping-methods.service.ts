import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma, ShippingMethod } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { conflictOnDuplicate, keySchema } from '../pricing/decimals';
import { liveRateSchema, parcelSchema } from './order-response';
import type { PortalShippingMethodsResponse, ShippingMethodResponse } from './order-response';

type Parcel = z.infer<typeof parcelSchema>;

/** Money in the workspace's currency: zero or more, at most cents. */
export const moneySchema = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'must be an amount with at most 2 places, such as 9.90');

const nameSchema = z.string().trim().min(1).max(200);

export const createShippingMethodSchema = z
  .object({
    key: keySchema,
    name: nameSchema,
    /** Per order; or leave it out and give `live_rate`. */
    price: moneySchema.optional(),
    /** Priced for each order by the workspace's courier service, at this carrier and service (Orders 3 spec, goal 22). */
    live_rate: liveRateSchema.optional(),
    /** The parcel a live rate is asked for, and a label's default; required with `live_rate`. */
    default_parcel: parcelSchema.optional(),
  })
  .refine((body) => (body.price === undefined) !== (body.live_rate === undefined), {
    message: 'give either a price or a live_rate',
    path: ['price'],
  })
  .refine((body) => body.live_rate === undefined || body.default_parcel !== undefined, {
    message: 'a live-rate method needs the parcel its rate is asked for',
    path: ['default_parcel'],
  });
export const updateShippingMethodSchema = z.object({
  name: nameSchema.optional(),
  /** Only for a fixed-price method. */
  price: moneySchema.optional(),
  /** Only for a live-rate method. */
  live_rate: liveRateSchema.optional(),
  default_parcel: parcelSchema.optional(),
  /** Switched off, it can't be chosen for new orders; past orders keep it. */
  active: z.boolean().optional(),
});

export function toShippingMethod(row: ShippingMethod): ShippingMethodResponse {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    price: row.price?.toFixed(2) ?? null,
    live_rate: row.liveCarrier && row.liveService ? { carrier: row.liveCarrier, service: row.liveService } : null,
    default_parcel: (row.defaultParcel as Parcel | null) ?? null,
    active: row.active,
  };
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

  /** What a customer can choose for a new order: the active methods, without their ids. */
  async customerList(tenantId: string): Promise<PortalShippingMethodsResponse> {
    const rows = await this.prisma.inTenant(tenantId, (tx) => tx.shippingMethod.findMany({ where: { active: true }, orderBy: { key: 'asc' } }));
    // A live-rate method has no price until an address is given (POST …/shipping-rates).
    return { data: rows.map((row) => ({ key: row.key, name: row.name, price: row.price?.toFixed(2) ?? null })) };
  }

  async create(auth: TenantAuth, input: z.infer<typeof createShippingMethodSchema>): Promise<ShippingMethodResponse> {
    try {
      return await this.prisma.inTenant(auth.tenantId, async (tx) => {
        const created = toShippingMethod(
          await tx.shippingMethod.create({
            data: {
              key: input.key,
              name: input.name,
              price: input.price ?? null,
              liveCarrier: input.live_rate?.carrier ?? null,
              liveService: input.live_rate?.service ?? null,
              defaultParcel: input.default_parcel ?? undefined,
            },
          }),
        );
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
      // A method keeps its kind: a fixed price and a live rate are different methods to customers.
      const live = current.liveService !== null;
      if ((live && patch.price !== undefined) || (!live && patch.live_rate !== undefined)) {
        throw new ConflictException(live ? 'A live-rate method has no fixed price; add a fixed-price method instead' : 'Add a live-rate method instead');
      }
      const updated = toShippingMethod(
        await tx.shippingMethod.update({
          where: { id },
          data: {
            name: patch.name,
            price: patch.price,
            liveCarrier: patch.live_rate?.carrier,
            liveService: patch.live_rate?.service,
            defaultParcel: patch.default_parcel,
            active: patch.active,
          },
        }),
      );
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
