import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { Material, Prisma, StepPrice } from '../../generated/prisma/client';
import { UnitsService } from '../catalog/units';
import type { UnitDef } from '../catalog/units';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { MEASURE_DIMENSION, blocksSchema } from './blocks';
import type { Block, MaterialSource } from './blocks';
import { percentSchema } from './decimals';
import type { StepPriceResponse } from './pricing-response';
import { materialFit } from './step-cost';
import type { MaterialFacts } from './step-cost';

export const stepPriceSchema = z.object({
  /** Omitted for the step's default price. */
  material_id: z.uuid().optional(),
  failure_percent: percentSchema(0, 100),
  blocks: blocksSchema,
});

function toResponse(row: StepPrice): StepPriceResponse {
  return {
    id: row.id,
    step_type_id: row.stepTypeId,
    material_id: row.materialId,
    failure_percent: row.failurePercent.toFixed(),
    blocks: row.blocks as Block[],
  };
}

/** What each step costs, per material or as the step's default (Pricing spec, Q2, Q3). */
@Injectable()
export class StepPricesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly units: UnitsService,
    private readonly audit: AuditService,
  ) {}

  /** Creates the step's price for the material (or its default), or replaces it. */
  async put(auth: TenantAuth, stepTypeId: string, input: z.infer<typeof stepPriceSchema>): Promise<StepPriceResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.findStepType(tx, stepTypeId);
      // Serialises saves for the step: Postgres would let two null-material defaults in side by side.
      await tx.$queryRaw`SELECT id FROM step_type WHERE id = ${stepTypeId}::uuid FOR UPDATE`;
      await this.checkPrice(tx, stepTypeId, input);
      const materialId = input.material_id ?? null;

      const current = await tx.stepPrice.findFirst({ where: { stepTypeId, materialId } });
      const data = { failurePercent: input.failure_percent, blocks: input.blocks as Prisma.InputJsonValue };
      const row = current
        ? await tx.stepPrice.update({ where: { id: current.id }, data })
        : await tx.stepPrice.create({ data: { stepTypeId, materialId, ...data } });
      const saved = toResponse(row);
      await this.record(tx, auth, row.id, current ? toResponse(current) : undefined, saved);
      return saved;
    });
  }

  /** The step's default first, then its material prices by material key. */
  async list(tenantId: string, stepTypeId: string): Promise<StepPriceResponse[]> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      await this.findStepType(tx, stepTypeId);
      const rows = await tx.stepPrice.findMany({ where: { stepTypeId }, include: { material: { select: { key: true } } } });
      const order = (row: (typeof rows)[number]) => (row.material ? `1${row.material.key}` : '0');
      return rows.sort((a, b) => order(a).localeCompare(order(b))).map(toResponse);
    });
  }

  async remove(auth: TenantAuth, id: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const row = await tx.stepPrice.findUnique({ where: { id } });
      if (!row) {
        throw new NotFoundException('Step price not found');
      }
      await tx.stepPrice.delete({ where: { id } });
      await this.record(tx, auth, id, toResponse(row), undefined);
    });
  }

  /**
   * Everything a step price must meet beyond its schema, for the workspace's prices and partners'
   * alike: the step type exists and is priced (400 for one nobody prices), the material exists, and
   * the blocks fit (`checkBlocks`).
   */
  async checkPrice(tx: Prisma.TransactionClient, stepTypeId: string, input: z.infer<typeof stepPriceSchema>): Promise<void> {
    const stepType = await tx.stepType.findUnique({ where: { id: stepTypeId }, select: { key: true, summaryGroup: true } });
    if (!stepType) {
      throw new NotFoundException('Step type not found');
    }
    if (stepType.summaryGroup === null) {
      throw new BadRequestException(`${stepType.key} is not priced, so it can't have a price`);
    }
    if (input.material_id) {
      await this.findMaterial(tx, input.material_id);
    }
    await this.checkBlocks(tx, input.blocks);
  }

  /**
   * Save-time checks a schema cannot make (Q3): every unit exists and fits its measure, and every
   * material named on a block exists and can be charged as the block says. The configuration's
   * material is only known per quote, so it is checked there.
   */
  private async checkBlocks(tx: Prisma.TransactionClient, blocks: Block[]): Promise<void> {
    const units: UnitDef[] = await this.units.all(tx);
    const unit = (key: string): UnitDef => {
      const found = units.find((candidate) => candidate.key === key);
      if (!found) throw new BadRequestException(`Unknown unit ${key}`);
      return found;
    };
    const fitsMeasure = (measure: keyof typeof MEASURE_DIMENSION, unitKey: string) => {
      const dimension = MEASURE_DIMENSION[measure];
      if (!dimension) throw new BadRequestException(`${measure} cannot be priced`);
      if (unit(unitKey).dimension !== dimension) {
        throw new BadRequestException(`${unitKey} is not a unit of ${measure} (${dimension})`);
      }
    };
    const fixed = async (source: MaterialSource): Promise<MaterialFacts | null> => {
      if ('configuration' in source) return null;
      const material = await this.findMaterial(tx, source.material_id);
      return { key: material.key, densityGCm3: material.densityGCm3, pricedUnit: unit(material.pricedUnit) };
    };
    const fits = (refusal: ReturnType<typeof materialFit>) => {
      if (refusal) throw new BadRequestException(refusal.message);
    };

    for (const block of blocks) {
      switch (block.kind) {
        case 'material': {
          const material = await fixed(block.source);
          if (material) fits(materialFit(material, block.basis));
          break;
        }
        case 'machine_time':
        case 'labour':
          if (block.per) fitsMeasure(block.per.measure, block.per.unit);
          break;
        case 'per_measure':
          fitsMeasure(block.measure, block.unit);
          break;
        case 'batch':
          if (block.material) {
            const lostIn = unit(block.material.unit);
            if (lostIn.dimension !== 'mass' && lostIn.dimension !== 'volume') {
              throw new BadRequestException(`Batch material is an amount of mass or volume, not ${lostIn.key}`);
            }
            const material = await fixed(block.material.source);
            if (material) fits(materialFit(material, lostIn));
          }
          break;
        case 'fixed':
        case 'setup':
          break;
      }
    }
  }

  private async findStepType(tx: Prisma.TransactionClient, id: string): Promise<void> {
    if (!(await tx.stepType.findUnique({ where: { id }, select: { id: true } }))) {
      throw new NotFoundException('Step type not found');
    }
  }

  /** Row-level security hides other workspaces' materials, so a foreign id is simply not found. */
  private async findMaterial(tx: Prisma.TransactionClient, id: string): Promise<Material> {
    const material = await tx.material.findUnique({ where: { id } });
    if (!material) {
      throw new NotFoundException('Material not found');
    }
    return material;
  }

  private async record(
    tx: Prisma.TransactionClient,
    auth: TenantAuth,
    id: string,
    before: StepPriceResponse | undefined,
    after: StepPriceResponse | undefined,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'pricing.changed',
      subject: { type: 'step_price', id },
      before: before as Prisma.InputJsonValue | undefined,
      after: after as Prisma.InputJsonValue | undefined,
    });
  }
}
