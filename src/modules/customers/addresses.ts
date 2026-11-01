import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { addressSchema } from '../orders/order-response';
import type { Address } from '../orders/order-response';

// A customer's saved addresses and VAT number (Customers 2 spec, goals 6–10): orders start from the
// shipping address; invoices carry the billing address, else the shipping one, and the VAT number.

const vatNumberSchema = z.string().trim().min(1).max(40);

/** Replaces only the fields named; null clears one. */
export const customerAddressesSchema = z.strictObject({
  shipping_address: addressSchema.nullable().optional(),
  billing_address: addressSchema.nullable().optional(),
  /** Printed on invoices as given; it changes no tax. */
  vat_number: vatNumberSchema.nullable().optional(),
});
export type CustomerAddressesInput = z.infer<typeof customerAddressesSchema>;

export const customerAddressesResponseSchema = z.strictObject({
  shipping_address: addressSchema.nullable(),
  /** Null: invoices use the shipping address. */
  billing_address: addressSchema.nullable(),
  vat_number: z.string().nullable(),
});
export type CustomerAddressesResponse = z.infer<typeof customerAddressesResponseSchema>;

type AddressRow = { shippingAddress: Prisma.JsonValue; billingAddress: Prisma.JsonValue; vatNumber: string | null };

function toResponse(row: AddressRow): CustomerAddressesResponse {
  return {
    shipping_address: (row.shippingAddress as Address | null) ?? null,
    billing_address: (row.billingAddress as Address | null) ?? null,
    vat_number: row.vatNumber,
  };
}

/** Who changes a customer's addresses: staff, or one of the customer's own people. */
export interface AddressActor {
  tenantId: string;
  userId: string;
}

@Injectable()
export class CustomerAddressesService {
  private readonly logger = new Logger(CustomerAddressesService.name);
  private readonly hooks: ((tenantId: string, customerId: string) => Promise<void>)[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Runs once a change has committed (Task 4: the payment provider's customer record). A failure is logged. */
  afterAddressChange(hook: (tenantId: string, customerId: string) => Promise<void>): void {
    this.hooks.push(hook);
  }

  async get(tenantId: string, customerId: string): Promise<CustomerAddressesResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => toResponse(await this.find(tx, customerId)));
  }

  async set(actor: AddressActor, customerId: string, input: CustomerAddressesInput): Promise<CustomerAddressesResponse> {
    const after = await this.prisma.inTenant(actor.tenantId, async (tx) => {
      const before = toResponse(await this.find(tx, customerId));
      const json = (address: Address | null | undefined) =>
        address === undefined ? undefined : address === null ? Prisma.DbNull : (address as Prisma.InputJsonValue);
      const row = await tx.customer.update({
        where: { id: customerId },
        data: {
          shippingAddress: json(input.shipping_address),
          billingAddress: json(input.billing_address),
          vatNumber: input.vat_number,
        },
        select: { shippingAddress: true, billingAddress: true, vatNumber: true },
      });
      const after = toResponse(row);
      await this.audit.record(tx, {
        actor: { type: 'user', id: actor.userId },
        action: 'customer.addresses_changed',
        subject: { type: 'customer', id: customerId },
        before,
        after,
      });
      return after;
    });
    for (const hook of this.hooks) {
      await hook(actor.tenantId, customerId).catch((error: unknown) =>
        this.logger.error({ err: error, tenantId: actor.tenantId, customerId }, 'a hook after an address change failed'),
      );
    }
    return after;
  }

  private async find(tx: Prisma.TransactionClient, customerId: string): Promise<AddressRow> {
    const row = await tx.customer.findUnique({
      where: { id: customerId },
      select: { shippingAddress: true, billingAddress: true, vatNumber: true },
    });
    if (!row) {
      throw new NotFoundException('Customer not found');
    }
    return row;
  }
}
