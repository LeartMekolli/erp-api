import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { positiveAmountSchema } from '../pricing/decimals';
import { CAPACITY_PERIODS } from './partner-response';
import type { PartnerSetupResponse } from './partner-response';
import { lockPartner } from './partners.service';

const distinct = <T>(values: T[]) => new Set(values).size === values.length;

const capabilitySchema = z
  .strictObject({
    step_type_id: z.uuid(),
    min_quantity: z.number().int().min(1).max(1_000_000).default(1),
    max_quantity: z.number().int().min(1).max(1_000_000).nullable().default(null),
    /** The largest side of a piece's bounding box, in millimetres. */
    max_size_mm: positiveAmountSchema.nullable().default(null),
    capacity: z.number().int().min(1).max(1_000_000),
    capacity_period: z.enum(CAPACITY_PERIODS),
  })
  .refine((capability) => capability.max_quantity === null || capability.max_quantity >= capability.min_quantity, {
    path: ['max_quantity'],
    message: 'max_quantity must not be below min_quantity',
  });

export const capabilitiesSchema = z.object({
  capabilities: z
    .array(capabilitySchema)
    .max(50)
    .refine((capabilities) => distinct(capabilities.map((one) => one.step_type_id)), 'a step type must not repeat'),
});

export const closedPeriodsSchema = z.object({
  closed_periods: z
    .array(
      z
        .strictObject({ starts_on: z.iso.date(), ends_on: z.iso.date(), note: z.string().trim().min(1).max(200).nullable().default(null) })
        .refine((period) => period.ends_on >= period.starts_on, { path: ['ends_on'], message: 'ends_on must not be before starts_on' }),
    )
    .max(100),
});

export const offeringsSchema = z.object({
  option_value_ids: z.array(z.uuid()).max(500).refine(distinct, 'an option value must not repeat'),
});

export const limitsSchema = z.object({
  /** Jobs offered or accepted at once; null for no limit. */
  max_open_jobs: z.number().int().min(1).max(10_000).nullable().optional(),
  /** Take any job a customer sends directly, without an offer to accept (goal 11). */
  accepts_direct_orders: z.boolean().optional(),
});

/** Who makes a change: staff, or a partner person acting for the partner. */
type Actor = Pick<TenantAuth, 'tenantId' | 'userId'>;

const date = (value: string) => new Date(`${value}T00:00:00Z`);
const isoDate = (value: Date) => value.toISOString().slice(0, 10);

/**
 * A partner's capabilities, capacity, closed periods and offerings (Partners spec, goals 4–6), the
 * same for staff and the partner's people. Each set is replaced whole under the partner row lock, and
 * every change is audited with the setup before and after.
 */
@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(tenantId: string, partnerId: string): Promise<PartnerSetupResponse> {
    return this.prisma.inTenant(tenantId, (tx) => this.read(tx, partnerId));
  }

  /** Not-priced step types are allowed: final QC can be a partner's step. Only price lists refuse them. */
  async setCapabilities(auth: Actor, partnerId: string, input: z.infer<typeof capabilitiesSchema>): Promise<PartnerSetupResponse> {
    return this.change(auth, partnerId, async (tx) => {
      const ids = input.capabilities.map((one) => one.step_type_id);
      if ((await tx.stepType.count({ where: { id: { in: ids } } })) !== ids.length) {
        throw new NotFoundException('Step type not found');
      }
      await tx.partnerCapability.deleteMany({ where: { partnerId } });
      await tx.partnerCapability.createMany({
        data: input.capabilities.map((one) => ({
          partnerId,
          stepTypeId: one.step_type_id,
          minQuantity: one.min_quantity,
          maxQuantity: one.max_quantity,
          maxSizeMm: one.max_size_mm,
          capacity: one.capacity,
          capacityPeriod: one.capacity_period,
        })),
      });
    });
  }

  async setClosedPeriods(auth: Actor, partnerId: string, input: z.infer<typeof closedPeriodsSchema>): Promise<PartnerSetupResponse> {
    return this.change(auth, partnerId, async (tx) => {
      await tx.partnerClosedPeriod.deleteMany({ where: { partnerId } });
      await tx.partnerClosedPeriod.createMany({
        data: input.closed_periods.map((one) => ({
          partnerId,
          startsOn: date(one.starts_on),
          endsOn: date(one.ends_on),
          note: one.note,
        })),
      });
    });
  }

  async setOfferings(auth: Actor, partnerId: string, input: z.infer<typeof offeringsSchema>): Promise<PartnerSetupResponse> {
    return this.change(auth, partnerId, async (tx) => {
      const ids = input.option_value_ids;
      if ((await tx.optionValue.count({ where: { id: { in: ids } } })) !== ids.length) {
        throw new NotFoundException('Option value not found');
      }
      await tx.partnerOffering.deleteMany({ where: { partnerId } });
      await tx.partnerOffering.createMany({ data: ids.map((optionValueId) => ({ partnerId, optionValueId })) });
    });
  }

  async setLimits(auth: Actor, partnerId: string, input: z.infer<typeof limitsSchema>): Promise<PartnerSetupResponse> {
    return this.change(auth, partnerId, async (tx) => {
      await tx.partner.update({
        where: { id: partnerId },
        data: { maxOpenJobs: input.max_open_jobs, acceptsDirectOrders: input.accepts_direct_orders },
      });
    });
  }

  /** Row-level security hides other workspaces' rows, so their ids are simply not found. */
  private async change(
    auth: Actor,
    partnerId: string,
    apply: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<PartnerSetupResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockPartner(tx, partnerId);
      const before = await this.read(tx, partnerId);
      await apply(tx);
      const after = await this.read(tx, partnerId);
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'partner.changed',
        subject: { type: 'partner', id: partnerId },
        before,
        after,
      });
      return after;
    });
  }

  private async read(tx: Prisma.TransactionClient, partnerId: string): Promise<PartnerSetupResponse> {
    const partner = await tx.partner.findUnique({
      where: { id: partnerId },
      include: {
        capabilities: { include: { stepType: true }, orderBy: [{ stepType: { position: 'asc' } }, { stepType: { key: 'asc' } }] },
        closedPeriods: { orderBy: [{ startsOn: 'asc' }, { endsOn: 'asc' }] },
        offerings: { include: { optionValue: { include: { group: true } } } },
      },
    });
    if (!partner) {
      throw new NotFoundException('Partner not found');
    }
    return {
      partner_id: partner.id,
      max_open_jobs: partner.maxOpenJobs,
      accepts_direct_orders: partner.acceptsDirectOrders,
      capabilities: partner.capabilities.map((one) => ({
        step_type: { id: one.stepType.id, key: one.stepType.key, name: one.stepType.name },
        min_quantity: one.minQuantity,
        max_quantity: one.maxQuantity,
        max_size_mm: one.maxSizeMm?.toFixed() ?? null,
        capacity: one.capacity,
        capacity_period: one.capacityPeriod as (typeof CAPACITY_PERIODS)[number],
      })),
      closed_periods: partner.closedPeriods.map((one) => ({
        starts_on: isoDate(one.startsOn),
        ends_on: isoDate(one.endsOn),
        note: one.note,
      })),
      offerings: partner.offerings
        .map((one) => ({
          option_value_id: one.optionValue.id,
          group_key: one.optionValue.group.key,
          key: one.optionValue.key,
          name: one.optionValue.name,
        }))
        .sort((a, b) => a.group_key.localeCompare(b.group_key) || a.key.localeCompare(b.key)),
    };
  }
}
