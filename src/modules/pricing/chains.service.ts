import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma, StepType } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import type { ChainStep, StepEffect } from './chain';
import type {
  CategoryChainResponse,
  ProductChainResponse,
  StepEffectsResponse,
  StepTypeResponse,
  SummaryGroup,
} from './pricing-response';
import { toStepType } from './step-types.service';

const stepIdsSchema = z
  .array(z.uuid())
  .max(30)
  .refine((ids) => new Set(ids).size === ids.length, 'a step must not repeat');

export const chainSchema = z.object({ step_type_ids: stepIdsSchema });
export const stepEffectsSchema = z
  .object({ add: stepIdsSchema, remove: stepIdsSchema })
  .refine((effects) => !effects.add.some((id) => effects.remove.includes(id)), {
    path: ['remove'],
    message: 'a step cannot be both added and removed',
  });

const inChainOrder = (a: StepType, b: StepType) => a.position - b.position || a.key.localeCompare(b.key);
const listed = (rows: { stepType: StepType }[]) => rows.map((row) => row.stepType).sort(inChainOrder).map(toStepType);

export function toChainStep(row: StepType): ChainStep {
  return { id: row.id, key: row.key, name: row.name, position: row.position, summaryGroup: row.summaryGroup as SummaryGroup };
}

const fromResponse = (step: StepTypeResponse): ChainStep => ({
  id: step.id,
  key: step.key,
  name: step.name,
  position: step.position,
  summaryGroup: step.summary_group,
});

/** Category chains, a product's own chain, and the steps option values add or remove (Pricing spec R4). */
@Injectable()
export class ChainsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async setCategory(auth: TenantAuth, categoryId: string, input: z.infer<typeof chainSchema>): Promise<CategoryChainResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      // Two replacements at once would both delete, then collide on insert; the second waits here
      // instead, and reads the chain as the first one left it.
      await tx.$queryRaw`SELECT id FROM category WHERE id = ${categoryId}::uuid FOR UPDATE`;
      const before = await this.categoryChain(tx, categoryId);
      await this.checkSteps(tx, input.step_type_ids);
      await tx.categoryStep.deleteMany({ where: { categoryId } });
      await tx.categoryStep.createMany({ data: input.step_type_ids.map((stepTypeId) => ({ categoryId, stepTypeId })) });
      const after = await this.categoryChain(tx, categoryId);
      await this.record(tx, auth, 'category', categoryId, before.steps, after.steps);
      return after;
    });
  }

  async getCategory(tenantId: string, categoryId: string): Promise<CategoryChainResponse> {
    return this.prisma.inTenant(tenantId, (tx) => this.categoryChain(tx, categoryId));
  }

  async setProduct(auth: TenantAuth, productId: string, input: z.infer<typeof chainSchema>): Promise<ProductChainResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM product WHERE id = ${productId}::uuid FOR UPDATE`;
      const before = await this.productChain(tx, productId);
      await this.checkSteps(tx, input.step_type_ids);
      await tx.productChain.upsert({ where: { productId }, create: { productId }, update: {} });
      await tx.productStep.deleteMany({ where: { productId } });
      await tx.productStep.createMany({ data: input.step_type_ids.map((stepTypeId) => ({ productId, stepTypeId })) });
      const after = await this.productChain(tx, productId);
      await this.record(tx, auth, 'product', productId, before, after);
      return after;
    });
  }

  async getProduct(tenantId: string, productId: string): Promise<ProductChainResponse> {
    return this.prisma.inTenant(tenantId, (tx) => this.productChain(tx, productId));
  }

  /** The product goes back to its category's chain. */
  async clearProduct(auth: TenantAuth, productId: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM product WHERE id = ${productId}::uuid FOR UPDATE`;
      const before = await this.productChain(tx, productId);
      await tx.productStep.deleteMany({ where: { productId } });
      await tx.productChain.deleteMany({ where: { productId } });
      await this.record(tx, auth, 'product', productId, before, await this.productChain(tx, productId));
    });
  }

  async setEffects(auth: TenantAuth, valueId: string, input: z.infer<typeof stepEffectsSchema>): Promise<StepEffectsResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM option_value WHERE id = ${valueId}::uuid FOR UPDATE`;
      const before = await this.effectsOf(tx, valueId);
      await this.checkSteps(tx, [...input.add, ...input.remove]);
      await tx.optionStepEffect.deleteMany({ where: { valueId } });
      await tx.optionStepEffect.createMany({
        data: [
          ...input.add.map((stepTypeId) => ({ valueId, stepTypeId, effect: 'add' })),
          ...input.remove.map((stepTypeId) => ({ valueId, stepTypeId, effect: 'remove' })),
        ],
      });
      const after = await this.effectsOf(tx, valueId);
      await this.record(tx, auth, 'option_value', valueId, before, after);
      return after;
    });
  }

  async getEffects(tenantId: string, valueId: string): Promise<StepEffectsResponse> {
    return this.prisma.inTenant(tenantId, (tx) => this.effectsOf(tx, valueId));
  }

  /** What `resolveChain` needs for a product: its base chain and every option step effect. */
  async load(tx: Prisma.TransactionClient, productId: string): Promise<{ base: ChainStep[]; effects: StepEffect[] }> {
    const chain = await this.productChain(tx, productId);
    const effects = await tx.optionStepEffect.findMany({ include: { stepType: true, value: { select: { key: true } } } });
    return {
      base: chain.steps.map(fromResponse),
      effects: effects.map((row) => ({
        valueId: row.valueId,
        valueKey: row.value.key,
        step: toChainStep(row.stepType),
        effect: row.effect as StepEffect['effect'],
      })),
    };
  }

  private async categoryChain(tx: Prisma.TransactionClient, categoryId: string): Promise<CategoryChainResponse> {
    const category = await tx.category.findUnique({
      where: { id: categoryId },
      include: { steps: { include: { stepType: true } } },
    });
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    return { category_id: category.id, steps: listed(category.steps) };
  }

  private async productChain(tx: Prisma.TransactionClient, productId: string): Promise<ProductChainResponse> {
    const product = await tx.product.findUnique({
      where: { id: productId },
      include: { chain: true, steps: { include: { stepType: true } } },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    if (product.chain) {
      return { product_id: product.id, own_chain: true, steps: listed(product.steps) };
    }
    return { product_id: product.id, own_chain: false, steps: (await this.categoryChain(tx, product.categoryId)).steps };
  }

  private async effectsOf(tx: Prisma.TransactionClient, valueId: string): Promise<StepEffectsResponse> {
    const value = await tx.optionValue.findUnique({
      where: { id: valueId },
      include: { stepEffects: { include: { stepType: true } } },
    });
    if (!value) {
      throw new NotFoundException('Option value not found');
    }
    return {
      value_id: value.id,
      add: listed(value.stepEffects.filter((row) => row.effect === 'add')),
      remove: listed(value.stepEffects.filter((row) => row.effect === 'remove')),
    };
  }

  /** Row-level security hides other workspaces' step types, so a foreign id is simply not found. */
  private async checkSteps(tx: Prisma.TransactionClient, ids: string[]): Promise<void> {
    if ((await tx.stepType.count({ where: { id: { in: ids } } })) !== new Set(ids).size) {
      throw new NotFoundException('Step type not found');
    }
  }

  private async record(
    tx: Prisma.TransactionClient,
    auth: TenantAuth,
    type: string,
    id: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'pricing.changed',
      subject: { type: `${type}_steps`, id },
      before: before as Prisma.InputJsonValue,
      after: after as Prisma.InputJsonValue,
    });
  }
}
