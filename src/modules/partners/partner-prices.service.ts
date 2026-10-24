import { Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { PartnerStepPrice, Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import type { Block } from '../pricing/blocks';
import type { StepPriceResponse } from '../pricing/pricing-response';
import { StepPricesService } from '../pricing/step-prices.service';
import type { stepPriceSchema } from '../pricing/step-prices.service';
import type { PartnerPricesResponse } from './partner-response';
import { lockPartner } from './partners.service';

/** Who makes a change: staff, or a partner person acting for the partner. */
type Actor = Pick<TenantAuth, 'tenantId' | 'userId'>;

function toResponse(row: PartnerStepPrice): StepPriceResponse {
  return {
    id: row.id,
    step_type_id: row.stepTypeId,
    material_id: row.materialId,
    failure_percent: row.failurePercent.toFixed(),
    blocks: row.blocks as Block[],
  };
}

/**
 * A partner's price list (Partners spec, goal 8): the workspace's step price blocks and checks, with
 * the partner's own numbers. Saves lock the partner row, which keeps one default per step type.
 */
@Injectable()
export class PartnerPricesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stepPrices: StepPricesService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, partnerId: string): Promise<PartnerPricesResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      if ((await tx.partner.count({ where: { id: partnerId } })) === 0) {
        throw new NotFoundException('Partner not found');
      }
      return this.read(tx, partnerId);
    });
  }

  /** Creates the partner's price for the step and material (or the step's default), or replaces it. */
  async put(
    auth: Actor,
    partnerId: string,
    stepTypeId: string,
    input: z.infer<typeof stepPriceSchema>,
  ): Promise<StepPriceResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockPartner(tx, partnerId);
      await this.stepPrices.checkPrice(tx, stepTypeId, input);
      const materialId = input.material_id ?? null;
      const current = await tx.partnerStepPrice.findFirst({ where: { partnerId, stepTypeId, materialId } });
      const data = { failurePercent: input.failure_percent, blocks: input.blocks as Prisma.InputJsonValue };
      const row = current
        ? await tx.partnerStepPrice.update({ where: { id: current.id }, data })
        : await tx.partnerStepPrice.create({ data: { partnerId, stepTypeId, materialId, ...data } });
      const saved = toResponse(row);
      await this.record(tx, auth, partnerId, { price: current ? toResponse(current) : null }, { price: saved });
      return saved;
    });
  }

  /**
   * Starts the partner's list from the workspace's: every workspace price, default or per material,
   * of the priced step types among the partner's capabilities that the partner hasn't priced yet.
   * Prices it already has are left as they are, so copying twice adds nothing.
   */
  async copyFromWorkspace(auth: Actor, partnerId: string): Promise<PartnerPricesResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await lockPartner(tx, partnerId);
      const capabilities = await tx.partnerCapability.findMany({
        where: { partnerId, stepType: { summaryGroup: { not: null } } },
        select: { stepTypeId: true },
      });
      const workspace = await tx.stepPrice.findMany({
        where: { stepTypeId: { in: capabilities.map((capability) => capability.stepTypeId) } },
      });
      const priced = new Set(
        (await tx.partnerStepPrice.findMany({ where: { partnerId }, select: { stepTypeId: true, materialId: true } })).map(
          (row) => `${row.stepTypeId}:${row.materialId}`,
        ),
      );
      const missing = workspace.filter((row) => !priced.has(`${row.stepTypeId}:${row.materialId}`));
      const before = await this.read(tx, partnerId);
      if (missing.length > 0) {
        await tx.partnerStepPrice.createMany({
          data: missing.map((row) => ({
            partnerId,
            stepTypeId: row.stepTypeId,
            materialId: row.materialId,
            failurePercent: row.failurePercent,
            blocks: row.blocks as Prisma.InputJsonValue,
          })),
        });
      }
      const after = await this.read(tx, partnerId);
      if (missing.length > 0) {
        await this.record(tx, auth, partnerId, before, after);
      }
      return after;
    });
  }

  /** In step type order, each step's default first, then its material prices by material key. */
  private async read(tx: Prisma.TransactionClient, partnerId: string): Promise<PartnerPricesResponse> {
    const rows = await tx.partnerStepPrice.findMany({
      where: { partnerId },
      include: { stepType: { select: { position: true, key: true } }, material: { select: { key: true } } },
    });
    const order = (row: (typeof rows)[number]) => [row.stepType.position, row.stepType.key, row.material ? `1${row.material.key}` : '0'] as const;
    rows.sort((a, b) => {
      const [positionA, keyA, materialA] = order(a);
      const [positionB, keyB, materialB] = order(b);
      return positionA - positionB || keyA.localeCompare(keyB) || materialA.localeCompare(materialB);
    });
    return { data: rows.map(toResponse) };
  }

  private async record(
    tx: Prisma.TransactionClient,
    auth: Actor,
    partnerId: string,
    before: object,
    after: object,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'partner.changed',
      subject: { type: 'partner_prices', id: partnerId },
      before: before as Prisma.InputJsonValue,
      after: after as Prisma.InputJsonValue,
    });
  }
}
