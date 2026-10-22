import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import { toPage } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { Customer, CustomerGroup, Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import type { CustomerResponse } from './customer-response';

const nameSchema = z.string().trim().min(1).max(200);

export const createCustomerSchema = z.object({
  name: nameSchema,
  /** A Pricing customer group of the workspace. */
  customer_group_id: z.uuid().optional(),
});
export const updateCustomerSchema = z.object({
  name: nameSchema.optional(),
  /** A disabled customer's people cannot act for it; its data is kept. */
  status: z.enum(['active', 'disabled']).optional(),
  /** Null removes the group. */
  customer_group_id: z.uuid().nullable().optional(),
});

type CustomerRow = Customer & { customerGroup: CustomerGroup | null };

const include = { customerGroup: true } as const;

/** Customer organisations, as staff manage them (Customers spec, goal 1). */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async create(auth: TenantAuth, input: z.infer<typeof createCustomerSchema>): Promise<CustomerResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      if (input.customer_group_id) await this.findGroup(tx, input.customer_group_id);
      const row = await tx.customer.create({
        data: { name: input.name, customerGroupId: input.customer_group_id ?? null },
        include,
      });
      const created = await this.toResponse(tx, row);
      await this.record(tx, auth, row.id, undefined, created);
      return created;
    });
  }

  async list(tenantId: string, query: { limit: number; cursor?: string }): Promise<Page<CustomerResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      const rows = await tx.customer.findMany({
        where: after ? { id: { lt: after.id } } : {},
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        include,
      });
      const page = toPage(rows, query.limit, secret);
      const data: CustomerResponse[] = [];
      for (const row of page.data) {
        data.push(await this.toResponse(tx, row));
      }
      return { data, next_cursor: page.next_cursor };
    });
  }

  async get(tenantId: string, id: string): Promise<CustomerResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => this.toResponse(tx, await this.find(tx, id)));
  }

  async update(auth: TenantAuth, id: string, patch: z.infer<typeof updateCustomerSchema>): Promise<CustomerResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const before = await this.toResponse(tx, await this.find(tx, id));
      if (patch.customer_group_id) await this.findGroup(tx, patch.customer_group_id);
      const row = await tx.customer.update({
        where: { id },
        data: { name: patch.name, status: patch.status, customerGroupId: patch.customer_group_id },
        include,
      });
      const after = await this.toResponse(tx, row);
      await this.record(tx, auth, id, before, after);
      return after;
    });
  }

  /** Row-level security hides other workspaces' customers, so a foreign id is simply not found. */
  async find(tx: Prisma.TransactionClient, id: string): Promise<CustomerRow> {
    const row = await tx.customer.findUnique({ where: { id }, include });
    if (!row) {
      throw new NotFoundException('Customer not found');
    }
    return row;
  }

  private async findGroup(tx: Prisma.TransactionClient, id: string): Promise<void> {
    if (!(await tx.customerGroup.findUnique({ where: { id }, select: { id: true } }))) {
      throw new NotFoundException('Customer group not found');
    }
  }

  private async toResponse(tx: Prisma.TransactionClient, row: CustomerRow): Promise<CustomerResponse> {
    const memberCount = await tx.organisationMembership.count({
      where: { organisationType: 'customer', organisationId: row.id },
    });
    return {
      id: row.id,
      name: row.name,
      status: row.status as CustomerResponse['status'],
      customer_group: row.customerGroup
        ? { id: row.customerGroup.id, key: row.customerGroup.key, name: row.customerGroup.name }
        : null,
      member_count: memberCount,
      created_at: row.createdAt.toISOString(),
    };
  }

  private async record(
    tx: Prisma.TransactionClient,
    auth: TenantAuth,
    id: string,
    before: CustomerResponse | undefined,
    after: CustomerResponse,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'customer.changed',
      subject: { type: 'customer', id },
      before,
      after,
    });
  }
}
