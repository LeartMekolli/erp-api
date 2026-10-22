import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { MeasureType } from '../files/measurers';
import type { CheckResponse } from './check-response';
import { checkConfiguration } from './config-check';
import type { CheckInput } from './config-check';
import { toCurrentPrice } from './material-response';
import { MaterialsService } from './materials.service';
import { OptionsService } from './options.service';
import { ProductsService } from './products.service';
import type { ProductForCheck } from './products.service';
import { scaleSchema } from './scaling';

export const checkRequestSchema = z.object({
  /** Chosen value key by group key, such as `{ "material": "silver_925" }`. */
  options: z
    .record(z.string().max(64), z.string().max(64))
    .refine((options) => Object.keys(options).length <= 50, 'at most 50 options')
    .default({}),
  size: z.union([z.strictObject({ scale: scaleSchema }), z.strictObject({ named: z.string().min(1).max(32) })]).optional(),
  /** The customer's design file version, for a custom product. */
  file_version_id: z.uuid().optional(),
});

/** Checks a configuration of a product; nothing is stored (Catalog spec, "Configuration check"). */
@Injectable()
export class CheckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly options: OptionsService,
    private readonly materials: MaterialsService,
  ) {}

  async check(tenantId: string, productId: string, body: z.infer<typeof checkRequestSchema>): Promise<CheckResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const product = await this.products.loadForCheck(tx, productId);
      const file = await this.designFile(tx, product, body.file_version_id);
      const groups = await this.options.groupsWithValues(tx);
      const result = checkConfiguration({
        product,
        values: groups.flatMap((group) =>
          group.values.map((value) => ({ id: value.id, key: value.key, groupId: value.group_id, materialId: value.material_id })),
        ),
        rules: await this.options.rules(tx),
        options: body.options,
        size: body.size && ('scale' in body.size ? { scale: new Prisma.Decimal(body.size.scale) } : body.size),
        file,
      });
      if (!result.accepted) {
        return { accepted: false, reasons: result.reasons };
      }

      const material = await this.materials.find(tx, result.materialId);
      const price = await this.materials.priceOf(tx, tenantId, material);
      if ('missing' in price) {
        return { accepted: false, reasons: [{ code: 'price_missing', message: price.missing }] };
      }
      return {
        accepted: true,
        options: Object.fromEntries(result.values.map((chosen) => [chosen.group, chosen.value])),
        scale: result.scale.toFixed(),
        measures: result.measures.map((measure) => ({
          type: measure.type,
          value: measure.value.toFixed(6),
          unit: measure.unit,
        })),
        material: { id: material.id, key: material.key, name: material.name, price: toCurrentPrice(price) },
      };
    });
  }

  /** A ready-made product's own version, or the customer's for a custom product (B1, B2). */
  private async designFile(
    tx: Prisma.TransactionClient,
    product: ProductForCheck,
    versionId: string | undefined,
  ): Promise<CheckInput['file']> {
    if (product.kind === 'ready_made') {
      if (versionId) {
        throw new BadRequestException('A ready-made product is checked with its own design file; omit file_version_id');
      }
      return product.design;
    }
    if (!versionId) {
      return null;
    }
    // Row-level security hides other tenants' versions, so a foreign id is simply not found.
    const version = await tx.fileVersion.findUnique({
      where: { id: versionId },
      include: { file: { select: { kind: true } }, measures: true },
    });
    if (!version) {
      throw new NotFoundException('File version not found');
    }
    if (version.file.kind !== 'design') {
      throw new BadRequestException('file_version_id must be a version of a design file');
    }
    return {
      status: version.status,
      measures: version.measures.map((measure) => ({
        type: measure.type as MeasureType,
        value: measure.value,
        unit: measure.unit,
      })),
    };
  }
}
