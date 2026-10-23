import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { Defect, Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { conflictOnDuplicate, keySchema } from '../pricing/decimals';
import type { DefectResponse } from './workflow-response';

const nameSchema = z.string().trim().min(1).max(200);

export const createDefectSchema = z.object({ key: keySchema, name: nameSchema });
export const updateDefectSchema = z.object({ name: nameSchema.optional(), active: z.boolean().optional() });

function toDefect(row: Defect): DefectResponse {
  return { id: row.id, key: row.key, name: row.name, active: row.active };
}

/** The workspace's defect catalogue (D38). */
@Injectable()
export class DefectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(auth: TenantAuth, input: z.infer<typeof createDefectSchema>): Promise<DefectResponse> {
    try {
      return await this.prisma.inTenant(auth.tenantId, async (tx) => {
        const created = toDefect(await tx.defect.create({ data: { key: input.key, name: input.name } }));
        await this.record(tx, auth, created.id, undefined, created);
        return created;
      });
    } catch (error) {
      conflictOnDuplicate(error, `A defect with key ${input.key} already exists`);
    }
  }

  async list(tenantId: string): Promise<DefectResponse[]> {
    const rows = await this.prisma.inTenant(tenantId, (tx) => tx.defect.findMany({ orderBy: { key: 'asc' } }));
    return rows.map(toDefect);
  }

  async update(auth: TenantAuth, id: string, patch: z.infer<typeof updateDefectSchema>): Promise<DefectResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const current = await tx.defect.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('Defect not found');
      }
      const updated = toDefect(await tx.defect.update({ where: { id }, data: { name: patch.name, active: patch.active } }));
      await this.record(tx, auth, id, toDefect(current), updated);
      return updated;
    });
  }

  private async record(
    tx: Prisma.TransactionClient,
    auth: TenantAuth,
    id: string,
    before: DefectResponse | undefined,
    after: DefectResponse,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'workflow.changed',
      subject: { type: 'defect', id },
      before,
      after,
    });
  }
}
