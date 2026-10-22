import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import { toPage } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { Category } from '../../generated/prisma/client';
import { MEASURE_TYPES } from '../files/measurers';
import type { MeasureType } from '../files/measurers';
import type { CategoryResponse, ProductResponse } from './product-response';
import { sizingSchema } from './scaling';
import type { ScalableMeasure, Sizing } from './scaling';

const keySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'lowercase letters, digits and _, starting with a letter');
const nameSchema = z.string().trim().min(1).max(200);
const uniqueIds = (max: number) =>
  z
    .array(z.uuid())
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, 'ids must not repeat');

export const createCategorySchema = z.object({
  key: keySchema,
  name: nameSchema,
  required_measures: z
    .array(z.enum(MEASURE_TYPES))
    .refine((types) => new Set(types).size === types.length, 'measures must not repeat')
    .default([]),
});

export const createProductSchema = z.object({
  category_id: z.uuid(),
  key: keySchema,
  name: nameSchema,
  kind: z.enum(['custom', 'ready_made']),
  sizing: sizingSchema.default({ mode: 'none' }),
  material_id: z.uuid().optional(),
});
export const updateProductSchema = z.object({
  category_id: z.uuid().optional(),
  name: nameSchema.optional(),
  sizing: sizingSchema.optional(),
  material_id: z.uuid().nullable().optional(),
});

export const productOptionsInputSchema = z.object({
  groups: z
    .array(
      z
        .object({
          group_id: z.uuid(),
          required: z.boolean(),
          default_value_id: z.uuid().nullable().optional(),
          value_ids: uniqueIds(200).min(1),
        })
        .refine((group) => !group.default_value_id || group.value_ids.includes(group.default_value_id), {
          path: ['default_value_id'],
          message: 'must be one of value_ids',
        }),
    )
    .max(50)
    .refine((groups) => new Set(groups.map((group) => group.group_id)).size === groups.length, 'a group must not repeat'),
});

export const designFileSchema = z.object({ file_version_id: z.uuid() });

/** What the configuration check needs to know about a product (Catalog plan, Task 7). */
export interface ProductForCheck {
  id: string;
  key: string;
  kind: 'custom' | 'ready_made';
  sizing: Sizing;
  materialId: string | null;
  requiredMeasures: MeasureType[];
  groups: {
    id: string;
    key: string;
    required: boolean;
    defaultValueId: string | null;
    /** The values the product allows in this group. */
    values: { id: string; key: string; materialId: string | null }[];
  }[];
  /** A ready-made product's pinned version and its measures; `null` for a custom product. */
  design: { fileVersionId: string; status: string; measures: ScalableMeasure[] } | null;
}

const productInclude = {
  fileVersion: { select: { id: true, fileId: true } },
  optionGroups: { orderBy: { position: 'asc' } },
  optionValues: { include: { value: { select: { groupId: true } } } },
} satisfies Prisma.ProductInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

function toCategory(row: Category): CategoryResponse {
  return { id: row.id, key: row.key, name: row.name, required_measures: row.requiredMeasures as MeasureType[] };
}

function toProduct(row: ProductRow): ProductResponse {
  return {
    id: row.id,
    category_id: row.categoryId,
    key: row.key,
    name: row.name,
    kind: row.kind as ProductResponse['kind'],
    status: row.status,
    material_id: row.materialId,
    sizing: row.sizing as Sizing,
    design_file: row.fileVersion ? { file_id: row.fileVersion.fileId, version_id: row.fileVersion.id } : null,
    options: row.optionGroups.map((group) => ({
      group_id: group.groupId,
      required: group.required,
      default_value_id: group.defaultValueId,
      value_ids: row.optionValues.filter((offer) => offer.value.groupId === group.groupId).map((offer) => offer.valueId),
    })),
  };
}

function conflict(error: unknown, message: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictException(message);
  }
  throw error;
}

/** Categories and products, custom or ready-made (Catalog spec C2, C3, C4, B1). */
@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async createCategory(tenantId: string, input: z.infer<typeof createCategorySchema>): Promise<CategoryResponse> {
    try {
      return toCategory(
        await this.prisma.inTenant(tenantId, (tx) =>
          tx.category.create({ data: { key: input.key, name: input.name, requiredMeasures: input.required_measures } }),
        ),
      );
    } catch (error) {
      conflict(error, `A category with key ${input.key} already exists`);
    }
  }

  async listCategories(tenantId: string): Promise<CategoryResponse[]> {
    const rows = await this.prisma.inTenant(tenantId, (tx) => tx.category.findMany({ orderBy: { id: 'asc' } }));
    return rows.map(toCategory);
  }

  async create(tenantId: string, input: z.infer<typeof createProductSchema>): Promise<ProductResponse> {
    try {
      return await this.prisma.inTenant(tenantId, async (tx) => {
        await this.findCategory(tx, input.category_id);
        await this.checkMaterial(tx, input.material_id);
        const row = await tx.product.create({
          data: {
            categoryId: input.category_id,
            key: input.key,
            name: input.name,
            kind: input.kind,
            sizing: input.sizing,
            materialId: input.material_id ?? null,
          },
          include: productInclude,
        });
        return toProduct(row);
      });
    } catch (error) {
      conflict(error, `A product with key ${input.key} already exists`);
    }
  }

  async list(tenantId: string, query: { limit: number; cursor?: string }): Promise<Page<ProductResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    const rows = await this.prisma.inTenant(tenantId, (tx) =>
      tx.product.findMany({
        where: after ? { id: { lt: after.id } } : {},
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        include: productInclude,
      }),
    );
    const page = toPage(rows, query.limit, secret);
    return { data: page.data.map(toProduct), next_cursor: page.next_cursor };
  }

  async get(tenantId: string, id: string): Promise<ProductResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => toProduct(await this.find(tx, id)));
  }

  async update(tenantId: string, id: string, patch: z.infer<typeof updateProductSchema>): Promise<ProductResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const current = await this.find(tx, id);
      if (patch.category_id && patch.category_id !== current.categoryId) {
        const category = await this.findCategory(tx, patch.category_id);
        // A pinned design file must still have every measure the new category asks for (B1).
        if (current.fileVersionId) {
          await this.checkVersion(tx, current.fileVersionId, category.requiredMeasures);
        }
      }
      await this.checkMaterial(tx, patch.material_id ?? undefined);
      const row = await tx.product.update({
        where: { id },
        data: { categoryId: patch.category_id, name: patch.name, sizing: patch.sizing, materialId: patch.material_id },
        include: productInclude,
      });
      return toProduct(row);
    });
  }

  /** Replaces every option group the product offers. */
  async setOptions(tenantId: string, id: string, input: z.infer<typeof productOptionsInputSchema>): Promise<ProductResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      await this.find(tx, id);
      const groupIds = input.groups.map((group) => group.group_id);
      // Row-level security hides other tenants' groups and values, so a foreign id is simply not found.
      if ((await tx.optionGroup.count({ where: { id: { in: groupIds } } })) !== groupIds.length) {
        throw new NotFoundException('Option group not found');
      }
      const valueIds = input.groups.flatMap((group) => group.value_ids);
      const values = await tx.optionValue.findMany({ where: { id: { in: valueIds } }, select: { id: true, groupId: true } });
      if (values.length !== new Set(valueIds).size) {
        throw new NotFoundException('Option value not found');
      }
      const groupOf = new Map(values.map((value) => [value.id, value.groupId]));
      for (const group of input.groups) {
        if (group.value_ids.some((valueId) => groupOf.get(valueId) !== group.group_id)) {
          throw new BadRequestException(`Every value of group ${group.group_id} must belong to that group`);
        }
      }

      await tx.productOptionValue.deleteMany({ where: { productId: id } });
      await tx.productOptionGroup.deleteMany({ where: { productId: id } });
      await tx.productOptionGroup.createMany({
        data: input.groups.map((group, position) => ({
          productId: id,
          groupId: group.group_id,
          required: group.required,
          defaultValueId: group.default_value_id ?? null,
          position,
        })),
      });
      await tx.productOptionValue.createMany({ data: valueIds.map((valueId) => ({ productId: id, valueId })) });
      return toProduct(await this.find(tx, id));
    });
  }

  /** Pins a measured design file version on a ready-made product (B1). */
  async setDesignFile(tenantId: string, id: string, input: z.infer<typeof designFileSchema>): Promise<ProductResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const product = await this.find(tx, id);
      if (product.kind !== 'ready_made') {
        throw new ConflictException('Only a ready-made product carries its own design file');
      }
      const category = await this.findCategory(tx, product.categoryId);
      await this.checkVersion(tx, input.file_version_id, category.requiredMeasures);
      const row = await tx.product.update({
        where: { id },
        data: { fileVersionId: input.file_version_id },
        include: productInclude,
      });
      return toProduct(row);
    });
  }

  async loadForCheck(tx: Prisma.TransactionClient, id: string): Promise<ProductForCheck> {
    const row = await tx.product.findUnique({
      where: { id },
      include: {
        category: true,
        fileVersion: { include: { measures: true } },
        optionGroups: { orderBy: { position: 'asc' }, include: { group: true } },
        optionValues: { include: { value: true } },
      },
    });
    if (!row) {
      throw new NotFoundException('Product not found');
    }
    return {
      id: row.id,
      key: row.key,
      kind: row.kind as ProductForCheck['kind'],
      sizing: row.sizing as Sizing,
      materialId: row.materialId,
      requiredMeasures: row.category.requiredMeasures as MeasureType[],
      groups: row.optionGroups.map((group) => ({
        id: group.groupId,
        key: group.group.key,
        required: group.required,
        defaultValueId: group.defaultValueId,
        values: row.optionValues
          .filter((offer) => offer.value.groupId === group.groupId)
          .map((offer) => ({ id: offer.value.id, key: offer.value.key, materialId: offer.value.materialId })),
      })),
      design: row.fileVersion
        ? {
            fileVersionId: row.fileVersion.id,
            status: row.fileVersion.status,
            measures: row.fileVersion.measures.map((measure) => ({
              type: measure.type as MeasureType,
              value: measure.value,
              unit: measure.unit,
            })),
          }
        : null,
    };
  }

  private async find(tx: Prisma.TransactionClient, id: string): Promise<ProductRow> {
    const row = await tx.product.findUnique({ where: { id }, include: productInclude });
    if (!row) {
      throw new NotFoundException('Product not found');
    }
    return row;
  }

  private async findCategory(tx: Prisma.TransactionClient, id: string): Promise<Category> {
    const category = await tx.category.findUnique({ where: { id } });
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    return category;
  }

  private async checkMaterial(tx: Prisma.TransactionClient, materialId: string | undefined): Promise<void> {
    if (materialId && !(await tx.material.findUnique({ where: { id: materialId } }))) {
      throw new NotFoundException('Material not found');
    }
  }

  /** A design version is usable when it is measured and has every required measure (B1). */
  private async checkVersion(tx: Prisma.TransactionClient, versionId: string, required: string[]): Promise<void> {
    const version = await tx.fileVersion.findUnique({
      where: { id: versionId },
      include: { file: { select: { kind: true } }, measures: { select: { type: true } } },
    });
    if (!version) {
      throw new NotFoundException('File version not found');
    }
    if (version.file.kind !== 'design') {
      throw new ConflictException('The file is not a design file');
    }
    if (version.status !== 'measured') {
      throw new ConflictException(`The file version is ${version.status}, not measured yet`);
    }
    const present = new Set(version.measures.map((measure) => measure.type));
    const missing = required.filter((type) => !present.has(type));
    if (missing.length > 0) {
      throw new ConflictException(`The file version lacks the measures the category requires: ${missing.join(', ')}`);
    }
  }
}
