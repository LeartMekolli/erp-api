import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { OptionValue } from '../../generated/prisma/client';
import type { OptionGroupResponse, OptionRuleResponse, OptionValueResponse } from './option-response';

const keySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'lowercase letters, digits and _, starting with a letter');
const nameSchema = z.string().trim().min(1).max(200);

export const createGroupSchema = z.object({ key: keySchema, name: nameSchema });
export const createValueSchema = z.object({ key: keySchema, name: nameSchema, material_id: z.uuid().optional() });
export const updateValueSchema = z.object({ name: nameSchema.optional(), material_id: z.uuid().nullable().optional() });
export const createRuleSchema = z
  .object({
    kind: z.enum(['excludes', 'requires']),
    value_id: z.uuid(),
    target_value_ids: z
      .array(z.uuid())
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, 'target_value_ids must not repeat'),
  })
  .refine((rule) => !rule.target_value_ids.includes(rule.value_id), {
    path: ['target_value_ids'],
    message: 'A rule cannot target its own value',
  });

/** A rule as the configuration check reads it. */
export interface Rule {
  id: string;
  kind: 'excludes' | 'requires';
  valueId: string;
  targetValueIds: string[];
}

function toValue(row: OptionValue): OptionValueResponse {
  return { id: row.id, group_id: row.groupId, key: row.key, name: row.name, material_id: row.materialId };
}

function conflict(error: unknown, message: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictException(message);
  }
  throw error;
}

/** Option groups, values and the rules between values (Catalog spec C4, B9). */
@Injectable()
export class OptionsService {
  constructor(private readonly prisma: PrismaService) {}

  async createGroup(tenantId: string, input: z.infer<typeof createGroupSchema>): Promise<OptionGroupResponse> {
    try {
      const row = await this.prisma.inTenant(tenantId, (tx) => tx.optionGroup.create({ data: input }));
      return { id: row.id, key: row.key, name: row.name, values: [] };
    } catch (error) {
      conflict(error, `An option group with key ${input.key} already exists`);
    }
  }

  async listGroups(tenantId: string): Promise<OptionGroupResponse[]> {
    return this.prisma.inTenant(tenantId, (tx) => this.groupsWithValues(tx));
  }

  async groupsWithValues(tx: Prisma.TransactionClient, groupIds?: string[]): Promise<OptionGroupResponse[]> {
    const groups = await tx.optionGroup.findMany({
      where: groupIds ? { id: { in: groupIds } } : {},
      include: { values: { orderBy: { id: 'asc' } } },
      orderBy: { id: 'asc' },
    });
    return groups.map((group) => ({ id: group.id, key: group.key, name: group.name, values: group.values.map(toValue) }));
  }

  async createValue(tenantId: string, groupId: string, input: z.infer<typeof createValueSchema>): Promise<OptionValueResponse> {
    try {
      return await this.prisma.inTenant(tenantId, async (tx) => {
        if (!(await tx.optionGroup.findUnique({ where: { id: groupId } }))) {
          throw new NotFoundException('Option group not found');
        }
        await this.checkMaterial(tx, input.material_id);
        return toValue(
          await tx.optionValue.create({
            data: { groupId, key: input.key, name: input.name, materialId: input.material_id ?? null },
          }),
        );
      });
    } catch (error) {
      conflict(error, `The group already has a value with key ${input.key}`);
    }
  }

  async updateValue(tenantId: string, id: string, patch: z.infer<typeof updateValueSchema>): Promise<OptionValueResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      if (!(await tx.optionValue.findUnique({ where: { id } }))) {
        throw new NotFoundException('Option value not found');
      }
      await this.checkMaterial(tx, patch.material_id ?? undefined);
      return toValue(await tx.optionValue.update({ where: { id }, data: { name: patch.name, materialId: patch.material_id } }));
    });
  }

  async createRule(tenantId: string, input: z.infer<typeof createRuleSchema>): Promise<OptionRuleResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const ids = [input.value_id, ...input.target_value_ids];
      // Row-level security hides other tenants' values, so a foreign id is simply not found.
      if ((await tx.optionValue.count({ where: { id: { in: ids } } })) !== ids.length) {
        throw new NotFoundException('Option value not found');
      }
      const rule = await tx.optionRule.create({
        data: {
          kind: input.kind,
          valueId: input.value_id,
          targets: { create: input.target_value_ids.map((valueId) => ({ valueId })) },
        },
      });
      return { id: rule.id, kind: input.kind, value_id: input.value_id, target_value_ids: input.target_value_ids };
    });
  }

  async listRules(tenantId: string): Promise<OptionRuleResponse[]> {
    const rules = await this.prisma.inTenant(tenantId, (tx) => this.rules(tx));
    return rules.map((rule) => ({ id: rule.id, kind: rule.kind, value_id: rule.valueId, target_value_ids: rule.targetValueIds }));
  }

  async deleteRule(tenantId: string, id: string): Promise<void> {
    await this.prisma.inTenant(tenantId, async (tx) => {
      const { count } = await tx.optionRule.deleteMany({ where: { id } });
      if (count === 0) {
        throw new NotFoundException('Option rule not found');
      }
    });
  }

  async rules(tx: Prisma.TransactionClient): Promise<Rule[]> {
    const rows = await tx.optionRule.findMany({ include: { targets: true }, orderBy: { id: 'asc' } });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as Rule['kind'],
      valueId: row.valueId,
      targetValueIds: row.targets.map((target) => target.valueId),
    }));
  }

  private async checkMaterial(tx: Prisma.TransactionClient, materialId: string | undefined): Promise<void> {
    if (materialId && !(await tx.material.findUnique({ where: { id: materialId } }))) {
      throw new NotFoundException('Material not found');
    }
  }
}
