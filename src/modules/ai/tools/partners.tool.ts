import { z } from 'zod';
import type { PrismaService } from '../../../database/prisma.service';
import { MAX_TOOL_ROWS } from './tool';
import type { AiTool } from './tool';

/** Partner workshops as the partner screens show them (`partner.read`). */
export function partnerTools(prisma: PrismaService): AiTool<unknown>[] {
  const findPartners: AiTool<{ name: string }> = {
    name: 'find_partners',
    description: 'Find partner workshops whose name contains the text, at most 25.',
    permissions: ['partner.read'],
    input: z.strictObject({ name: z.string().min(1).max(100) }),
    run: (ctx, input) =>
      prisma.inTenant(ctx.tenantId, async (tx) => {
        const rows = await tx.partner.findMany({
          where: { OR: [{ name: { contains: input.name, mode: 'insensitive' } }, { displayName: { contains: input.name, mode: 'insensitive' } }] },
          orderBy: { name: 'asc' },
          take: MAX_TOOL_ROWS,
          select: { id: true, name: true, displayName: true, status: true },
        });
        return {
          data: rows.map((row) => ({ id: row.id, name: row.name, display_name: row.displayName, status: row.status })),
          refs: rows.map((row) => ({ type: 'partner' as const, id: row.id })),
        };
      }),
  };

  const getPartner: AiTool<{ id: string }> = {
    name: 'get_partner',
    description: 'One partner by id: its status, what it can do with its capacity, and its open jobs.',
    permissions: ['partner.read'],
    input: z.strictObject({ id: z.uuid() }),
    run: (ctx, input) =>
      prisma.inTenant(ctx.tenantId, async (tx) => {
        const partner = await tx.partner.findUnique({
          where: { id: input.id },
          select: {
            id: true,
            name: true,
            displayName: true,
            status: true,
            capabilities: { select: { capacity: true, capacityPeriod: true, stepType: { select: { name: true } } } },
            assignments: { where: { status: { in: ['offered', 'accepted'] } }, select: { id: true, status: true, dueOn: true }, take: MAX_TOOL_ROWS },
          },
        });
        if (!partner) return { data: null, refs: [] };
        return {
          data: {
            id: partner.id,
            name: partner.name,
            display_name: partner.displayName,
            status: partner.status,
            capabilities: partner.capabilities.map((row) => ({ step: row.stepType.name, capacity: row.capacity, per: row.capacityPeriod })),
            open_jobs: partner.assignments.map((job) => ({ id: job.id, status: job.status, due_on: job.dueOn?.toISOString().slice(0, 10) ?? null })),
          },
          refs: [{ type: 'partner' as const, id: partner.id }, ...partner.assignments.map((job) => ({ type: 'job' as const, id: job.id }))],
        };
      }),
  };

  return [findPartners, getPartner] as AiTool<unknown>[];
}
