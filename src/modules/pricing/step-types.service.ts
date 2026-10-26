import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { PricingProfile, StepType } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { amountSchema, conflictOnDuplicate, keySchema, percentSchema } from './decimals';
import { SUMMARY_GROUPS } from './pricing-response';
import type { PricingProfileResponse, StepTypeResponse, SummaryGroup } from './pricing-response';

const nameSchema = z.string().trim().min(1).max(200);
const positionSchema = z.number().int().min(0).max(10_000);

/** Null: a step nobody prices, such as final QC or packing (Workflow/QC spec F12). */
const summaryGroupSchema = z.enum(SUMMARY_GROUPS).nullable();

export const createStepTypeSchema = z.object({
  key: keySchema,
  name: nameSchema,
  position: positionSchema,
  summary_group: summaryGroupSchema,
});
export const updateStepTypeSchema = z.object({
  name: nameSchema.optional(),
  position: positionSchema.optional(),
  summary_group: summaryGroupSchema.optional(),
});

export const pricingProfileSchema = z.object({
  margin_percent: percentSchema(0, 1000),
  overhead_per_piece: amountSchema,
  quote_valid_hours: z.number().int().min(1).max(720),
});

/** A workspace's pricing defaults, as the engine reads them. */
export interface PricingDefaults {
  marginPercent: Prisma.Decimal;
  overheadPerPiece: Prisma.Decimal;
  quoteValidHours: number;
}

const DEFAULTS: PricingDefaults = {
  marginPercent: new Prisma.Decimal(0),
  overheadPerPiece: new Prisma.Decimal(0),
  quoteValidHours: 4,
};

export function toStepType(row: StepType): StepTypeResponse {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    position: row.position,
    summary_group: row.summaryGroup as SummaryGroup | null,
    priced: row.summaryGroup !== null,
  };
}

function toProfile(defaults: PricingDefaults): PricingProfileResponse {
  return {
    margin_percent: defaults.marginPercent.toFixed(),
    overhead_per_piece: defaults.overheadPerPiece.toFixed(),
    quote_valid_hours: defaults.quoteValidHours,
  };
}

/** Step types: the production operations a workspace prices (Pricing spec). */
@Injectable()
export class StepTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(auth: TenantAuth, input: z.infer<typeof createStepTypeSchema>): Promise<StepTypeResponse> {
    try {
      return await this.prisma.inTenant(auth.tenantId, async (tx) => {
        const row = await tx.stepType.create({
          data: { key: input.key, name: input.name, position: input.position, summaryGroup: input.summary_group },
        });
        const created = toStepType(row);
        await this.audit.record(tx, {
          actor: { type: 'user', id: auth.userId },
          action: 'pricing.changed',
          subject: { type: 'step_type', id: row.id },
          after: created,
        });
        return created;
      });
    } catch (error) {
      conflictOnDuplicate(error, `A step type with key ${input.key} already exists`);
    }
  }

  async list(tenantId: string): Promise<StepTypeResponse[]> {
    return (await this.prisma.inTenant(tenantId, (tx) => this.all(tx))).map(toStepType);
  }

  async update(auth: TenantAuth, id: string, patch: z.infer<typeof updateStepTypeSchema>): Promise<StepTypeResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const current = await tx.stepType.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('Step type not found');
      }
      if (patch.summary_group === null && current.summaryGroup !== null && (await this.inUse(tx, id))) {
        throw new ConflictException(`${current.key} is in a chain, an option effect or a step price, so it stays priced`);
      }
      const row = await tx.stepType.update({
        where: { id },
        data: { name: patch.name, position: patch.position, summaryGroup: patch.summary_group },
      });
      const updated = toStepType(row);
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'pricing.changed',
        subject: { type: 'step_type', id },
        before: toStepType(current),
        after: updated,
      });
      return updated;
    });
  }

  /** In chain order: position, then key. */
  async all(tx: Prisma.TransactionClient): Promise<StepType[]> {
    return tx.stepType.findMany({ orderBy: [{ position: 'asc' }, { key: 'asc' }] });
  }

  private async inUse(tx: Prisma.TransactionClient, stepTypeId: string): Promise<boolean> {
    const counts = await Promise.all([
      tx.categoryStep.count({ where: { stepTypeId } }),
      tx.productStep.count({ where: { stepTypeId } }),
      tx.optionStepEffect.count({ where: { stepTypeId } }),
      tx.stepPrice.count({ where: { stepTypeId } }),
    ]);
    return counts.some((count) => count > 0);
  }
}

/** The workspace's margin, overhead and quote validity (Pricing spec). */
@Injectable()
export class PricingProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async read(tenantId: string): Promise<PricingProfileResponse> {
    return toProfile(await this.prisma.inTenant(tenantId, (tx) => this.get(tx)));
  }

  async set(auth: TenantAuth, input: z.infer<typeof pricingProfileSchema>): Promise<PricingProfileResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const before = toProfile(await this.get(tx));
      const data = {
        marginPercent: input.margin_percent,
        overheadPerPiece: input.overhead_per_piece,
        quoteValidHours: input.quote_valid_hours,
      };
      const row = await tx.pricingProfile.upsert({ where: { tenantId: auth.tenantId }, create: data, update: data });
      const after = toProfile(fromRow(row));
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'pricing.changed',
        subject: { type: 'pricing_profile', id: row.id },
        before,
        after,
      });
      return after;
    });
  }

  async get(tx: Prisma.TransactionClient): Promise<PricingDefaults> {
    const row = await tx.pricingProfile.findFirst();
    return row ? fromRow(row) : DEFAULTS;
  }
}

function fromRow(row: PricingProfile): PricingDefaults {
  return { marginPercent: row.marginPercent, overheadPerPiece: row.overheadPerPiece, quoteValidHours: row.quoteValidHours };
}
