import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import { paginationQuerySchema, toPage } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { Customer, CustomerGroup, CustomerPaymentTerms, CustomerPriority, Prisma } from '../../generated/prisma/client';
import { paymentTermsResponse, setPaymentTermsSchema } from '../payments/payment-response';
import { writePaymentTerms } from '../payments/payment-terms.service';
import { workspaceCurrency } from '../payments/workspace-currency';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { emailSchema } from '../identity/email';
import { CustomerAddressesService, customerAddressesSchema } from './addresses';
import { CustomerInvitationsService } from './customer-invitations.service';
import { planOf } from '../payments/plans/plan-of';
import { keySchema } from '../pricing/decimals';
import { SettingsService } from '../settings/settings.service';
import type {
  CreatedCustomerResponse,
  CustomerBandChoices,
  CustomerGroupChoices,
  CustomerMemberResponse,
  CustomerResponse,
} from './customer-response';
import { CUSTOMER_ROLES } from './customer-roles';
import { lockCustomer } from './lock-customer';
import { bandInForce, bandWhere, isBandKey, prioritySettings, workspaceToday } from './priority/bands';
import type { PrioritySettings } from './priority/bands';

// Still importable from here, as it was before it moved to its own file.
export { lockCustomer };

const nameSchema = z.string().trim().min(1).max(200);

export const inviteSchema = z.object({ email: emailSchema, role: z.enum(CUSTOMER_ROLES) });

export const createCustomerSchema = z.object({
  name: nameSchema,
  /** A Pricing customer group of the workspace. */
  customer_group_id: z.uuid().optional(),
  /** Lets the customer's people pick the workshop that makes their quote, at that workshop's price. */
  may_pick_partner: z.boolean().optional(),
  shipping_address: customerAddressesSchema.shape.shipping_address,
  billing_address: customerAddressesSchema.shape.billing_address,
  vat_number: customerAddressesSchema.shape.vat_number,
  /** Needs `payment.write`. Without it, the customer pays first. */
  payment_terms: setPaymentTermsSchema.optional(),
  /** The customer's first person, invited once the customer is saved. */
  invitation: inviteSchema.optional(),
});
export type CreateCustomer = z.infer<typeof createCustomerSchema>;

/**
 * Text for Prisma's `contains`, which becomes an ILIKE pattern as given: `%` and `_` would match
 * anything, so they (and the escape character itself) are escaped with Postgres's default `\`.
 */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** A refusal from one part of the create body, with its `errors` paths under that part's key. */
function prefixed(error: unknown, prefix: string): unknown {
  if (!(error instanceof ConflictException)) return error;
  const body = error.getResponse();
  const errors = typeof body === 'object' && body !== null ? (body as { errors?: unknown }).errors : undefined;
  if (!Array.isArray(errors)) return error;
  return new ConflictException(
    {
      ...(body as object),
      errors: (errors as { path: string; message: string }[]).map((one) => ({ ...one, path: `${prefix}.${one.path}` })),
    },
    { cause: error },
  );
}

export const updateCustomerSchema = z.object({
  name: nameSchema.optional(),
  /** A disabled customer's people cannot act for it; its data is kept. */
  status: z.enum(['active', 'disabled']).optional(),
  /** Null removes the group. */
  customer_group_id: z.uuid().nullable().optional(),
  /** Lets the customer's people pick the workshop that makes their quote, at that workshop's price. */
  may_pick_partner: z.boolean().optional(),
});
/** The customer list's filters (Customers 2 spec, goal 3). */
export const customerListQuerySchema = paginationQuerySchema.extend({
  /** A customer group's id, or `none` for customers in no group. */
  customer_group: z.union([z.uuid(), z.literal('none')]).optional(),
  /** A priority band's key, the default band's included: customers whose band in force it is (Customers 2 spec, goal 16). */
  band: keySchema.optional(),
  /** Any part of the name, in any case. */
  q: z.string().trim().min(1).max(100).optional(),
  /** The whole name, in any case, so a new customer can be checked for a name already used. */
  name: nameSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

export const updateMemberSchema = z.object({
  /** Making someone owner turns the current owner into an admin. */
  role: z.enum(CUSTOMER_ROLES).optional(),
  /** The person's own status, for every customer they act for, as staff users have it: deactivated people cannot log in. */
  status: z.enum(['active', 'deactivated']).optional(),
});

type CustomerRow = Customer & {
  customerGroup: CustomerGroup | null;
  paymentTerms: CustomerPaymentTerms | null;
  priority: CustomerPriority | null;
};

const include = { customerGroup: true, paymentTerms: true, priority: true } as const;

/** What a customer's response is read against, once per request: its band in force and its money's currency. */
interface ResponseContext {
  settings: PrioritySettings;
  today: string;
  currency: string;
}

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

/** Customer organisations and their people, as staff manage them (Customers spec, goals 1 and 9). */
@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);
  private readonly groupHooks: ((tenantId: string, customerId: string) => Promise<void>)[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly addresses: CustomerAddressesService,
    private readonly invitations: CustomerInvitationsService,
  ) {}

  /**
   * The customer and whatever else the body names (addresses, payment terms, a first invitation), in
   * one transaction: all saved or none. The address hooks and the invitation email run after it commits;
   * the email failing then is answered as the invitation's `email_status`, never an error, since the
   * customer exists and a retry would make another.
   */
  async create(auth: TenantAuth, input: CreateCustomer): Promise<CreatedCustomerResponse> {
    if (input.payment_terms && !auth.permissions.has('payment.write')) {
      throw new ForbiddenException('Setting payment terms needs payment.write');
    }
    // A new customer has no addresses yet, so a null clears nothing and is left out.
    const addresses = {
      ...(input.shipping_address ? { shipping_address: input.shipping_address } : {}),
      ...(input.billing_address ? { billing_address: input.billing_address } : {}),
      ...(input.vat_number ? { vat_number: input.vat_number } : {}),
    };
    const hasAddresses = Object.keys(addresses).length > 0;
    const { created, invitation } = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      if (input.customer_group_id) await this.findGroup(tx, input.customer_group_id);
      const row = await tx.customer.create({
        data: { name: input.name, customerGroupId: input.customer_group_id ?? null, mayPickPartner: input.may_pick_partner ?? false },
        include,
      });
      const snapshot = await this.toResponse(tx, row);
      await this.record(tx, auth, row.id, undefined, snapshot);
      if (hasAddresses) {
        await this.addresses.setIn(tx, auth, row.id, addresses);
      }
      if (input.payment_terms) {
        await writePaymentTerms(tx, this.audit, auth.userId, row.id, input.payment_terms).catch((error: unknown) => {
          throw prefixed(error, 'payment_terms');
        });
      }
      const invitation = input.invitation
        ? await this.invitations
            .inviteIn(tx, auth.tenantId, row.id, { ...input.invitation, invitedByUserId: auth.userId })
            .catch((error: unknown) => {
              throw prefixed(error, 'invitation');
            })
        : undefined;
      // Only the terms change what the response shows; addresses aren't in it, and an invitation isn't a member yet.
      return { created: input.payment_terms ? await this.toResponse(tx, await this.find(tx, row.id)) : snapshot, invitation };
    });
    if (hasAddresses) await this.addresses.afterChange(auth.tenantId, created.id);
    return {
      ...created,
      invitation: invitation
        ? { ...invitation.response, email_status: await this.invitations.sendAndReport(invitation.notice, created.id) }
        : null,
    };
  }

  async list(tenantId: string, query: CustomerListQuery): Promise<Page<CustomerResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      if (query.customer_group && query.customer_group !== 'none' && !(await tx.customerGroup.findUnique({ where: { id: query.customer_group } }))) {
        throw new BadRequestException({
          message: 'Filter by a customer group of the workspace',
          errors: [{ path: 'customer_group', message: 'not a customer group of this workspace' }],
        });
      }
      const context = await this.responseContext(tx);
      if (query.band && !isBandKey(query.band, context.settings)) {
        throw new BadRequestException({
          message: 'Filter by a band of the workspace',
          errors: [{ path: 'band', message: 'not a band of customers.priority' }],
        });
      }
      const rows = await tx.customer.findMany({
        where: {
          ...(after ? { id: { lt: after.id } } : {}),
          ...(query.customer_group ? { customerGroupId: query.customer_group === 'none' ? null : query.customer_group } : {}),
          ...(query.band ? bandWhere(query.band, context.today, context.settings) : {}),
          // Prisma's insensitive `equals` is an ILIKE on Postgres, so `name` is escaped like `q`.
          AND: [
            ...(query.q ? [{ name: { contains: likeLiteral(query.q), mode: 'insensitive' as const } }] : []),
            ...(query.name ? [{ name: { equals: likeLiteral(query.name), mode: 'insensitive' as const } }] : []),
          ],
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        include,
      });
      const page = toPage(rows, query.limit, secret);
      const data: CustomerResponse[] = [];
      for (const row of page.data) {
        data.push(await this.toResponse(tx, row, context));
      }
      return { data, next_cursor: page.next_cursor };
    });
  }

  async get(tenantId: string, id: string): Promise<CustomerResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => this.toResponse(tx, await this.find(tx, id)));
  }

  /** The customer groups to pick from, by name, without Pricing's percent. */
  async groupChoices(tenantId: string): Promise<CustomerGroupChoices> {
    return this.prisma.inTenant(tenantId, async (tx) => ({
      data: await tx.customerGroup.findMany({
        orderBy: [{ name: 'asc' }, { key: 'asc' }],
        select: { id: true, key: true, name: true },
      }),
    }));
  }

  /** The priority bands to pick from: the default band first, then the workspace's bands in their order. */
  async bandChoices(tenantId: string): Promise<CustomerBandChoices> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const { defaultBand, bands } = await prioritySettings(tx, this.settings);
      return {
        data: [
          { key: defaultBand.key, name: defaultBand.name, default: true },
          ...bands.map((band) => ({ key: band.key, name: band.name, default: false })),
        ],
      };
    });
  }

  /**
   * Runs once the transaction that put a customer into a customer group has committed (Customers 2 spec,
   * goal 4: campaigns targeting the group). A hook failing is logged; the change stands.
   */
  afterGroupChange(hook: (tenantId: string, customerId: string) => Promise<void>): void {
    this.groupHooks.push(hook);
  }

  async update(auth: TenantAuth, id: string, patch: z.infer<typeof updateCustomerSchema>): Promise<CustomerResponse> {
    const { before, after } = await this.prisma.inTenant(auth.tenantId, async (tx) => {
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
      return { before, after };
    });
    if (after.customer_group && after.customer_group.id !== before.customer_group?.id) {
      for (const hook of this.groupHooks) {
        await hook(auth.tenantId, id).catch((error: unknown) =>
          this.logger.error({ err: error, tenantId: auth.tenantId, customerId: id }, 'a hook after a customer group change failed'),
        );
      }
    }
    return after;
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

  private async responseContext(tx: Prisma.TransactionClient): Promise<ResponseContext> {
    return {
      settings: await prioritySettings(tx, this.settings),
      today: (await workspaceToday(tx, new Date())).today,
      currency: await workspaceCurrency(tx),
    };
  }

  private async toResponse(tx: Prisma.TransactionClient, row: CustomerRow, context?: ResponseContext): Promise<CustomerResponse> {
    const { settings, today, currency } = context ?? (await this.responseContext(tx));
    const band = bandInForce(row.priority, today, settings);
    const memberCount = await tx.organisationMembership.count({
      where: { organisationType: 'customer', organisationId: row.id },
    });
    const plan = await planOf(tx, row.id);
    return {
      id: row.id,
      name: row.name,
      status: row.status as CustomerResponse['status'],
      customer_group: row.customerGroup
        ? { id: row.customerGroup.id, key: row.customerGroup.key, name: row.customerGroup.name }
        : null,
      member_count: memberCount,
      may_pick_partner: row.mayPickPartner,
      payment_terms: paymentTermsResponse(row.paymentTerms, currency),
      plan: { key: plan.key, name: plan.name },
      band: { key: band.key, name: band.name },
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
