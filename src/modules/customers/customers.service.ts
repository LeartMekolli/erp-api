import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import { toPage } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { Customer, CustomerGroup, Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import type { CustomerMemberResponse, CustomerResponse } from './customer-response';
import { CUSTOMER_ROLES } from './customer-roles';

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
  /** Lets the customer's people pick the workshop that makes their quote, at that workshop's price. */
  may_pick_partner: z.boolean().optional(),
});
export const updateMemberSchema = z.object({
  /** Making someone owner turns the current owner into an admin. */
  role: z.enum(CUSTOMER_ROLES).optional(),
  /** The person's own status, for every customer they act for, as staff users have it: deactivated people cannot log in. */
  status: z.enum(['active', 'deactivated']).optional(),
});

type CustomerRow = Customer & { customerGroup: CustomerGroup | null };

const include = { customerGroup: true } as const;

export const memberInclude = { user: { select: { id: true, name: true, email: true, status: true } } } as const;

export function memberResponse(row: {
  role: string;
  user: { id: string; name: string; email: string; status: string };
}): CustomerMemberResponse {
  return {
    user_id: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: row.role as CustomerMemberResponse['role'],
    status: row.user.status as CustomerMemberResponse['status'],
  };
}

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

/** Customer organisations and their people, as staff manage them (Customers spec, goals 1 and 9). */
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
        data: {
          name: patch.name,
          status: patch.status,
          customerGroupId: patch.customer_group_id,
          mayPickPartner: patch.may_pick_partner,
        },
        include,
      });
      const after = await this.toResponse(tx, row);
      await this.record(tx, auth, id, before, after);
      return after;
    });
  }

  /** The customer's people, in the order they joined. */
  async members(tenantId: string, customerId: string): Promise<{ data: CustomerMemberResponse[] }> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      await this.find(tx, customerId);
      const rows = await tx.organisationMembership.findMany({
        where: { organisationType: 'customer', organisationId: customerId },
        orderBy: { id: 'asc' },
        include: memberInclude,
      });
      return { data: rows.map((row) => memberResponse(row)) };
    });
  }

  /**
   * Staff may give any role. Making someone owner turns the current owner into
   * an admin in the same transaction; taking the owner role away otherwise is
   * refused, so the customer always keeps exactly one owner.
   */
  async updateMember(
    auth: TenantAuth,
    customerId: string,
    userId: string,
    patch: z.infer<typeof updateMemberSchema>,
  ): Promise<CustomerMemberResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockCustomer(tx, customerId);
      const membership = await tx.organisationMembership.findFirst({
        where: { userId, organisationType: 'customer', organisationId: customerId },
        include: memberInclude,
      });
      if (!membership) {
        throw new NotFoundException('Person not found');
      }
      const before = memberResponse(membership);

      if (patch.role && patch.role !== membership.role) {
        if (membership.role === 'owner') {
          throw new ConflictException('Make someone else owner first');
        }
        if (patch.role === 'owner') {
          await tx.organisationMembership.updateMany({
            where: { organisationType: 'customer', organisationId: customerId, role: 'owner' },
            data: { role: 'admin' },
          });
        }
        await tx.organisationMembership.update({ where: { id: membership.id }, data: { role: patch.role } });
      }
      if (patch.status) {
        await tx.user.update({ where: { id: userId }, data: { status: patch.status } });
      }
      // As staff deactivation does: every session ends, not only the next request.
      if (patch.status === 'deactivated' && membership.user.status !== 'deactivated') {
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'logout' },
        });
      }

      const after = memberResponse(
        await tx.organisationMembership.findUniqueOrThrow({ where: { id: membership.id }, include: memberInclude }),
      );
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'customer.member_changed',
        subject: { type: 'customer', id: customerId },
        before,
        after,
      });
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
      may_pick_partner: row.mayPickPartner,
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
