import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { TenantAuth } from '../identity/auth-context';
import { SEARCH_LIMIT } from './search-response';
import type { SearchResponse } from './search-response';

/**
 * Cmd+K's plain search (AI 1 spec, goal 10): orders by the start of their number, customers and partners
 * by any part of their name, published articles by title. Each kind only where the user may read it.
 * No AI, no cost.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(auth: TenantAuth, q: string): Promise<SearchResponse> {
    const may = (permission: 'order.read' | 'customer.read' | 'partner.read') => auth.permissions.has(permission);
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { kind: true } });
      if (user?.kind !== 'staff') throw new ForbiddenException('Search is for staff');

      const name = { contains: q, mode: 'insensitive' as const };
      let orders: SearchResponse['orders'] = [];
      if (may('order.read') && /^\d{1,9}$/.test(q)) {
        // A number's text starts with the digits typed; numbers are short, so this scans few rows.
        const ids = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "order" WHERE number::text LIKE ${`${q}%`} ORDER BY number LIMIT ${SEARCH_LIMIT}`;
        const rows = await tx.order.findMany({
          where: { id: { in: ids.map((row) => row.id) } },
          orderBy: { number: 'asc' },
          select: { id: true, number: true, customer: { select: { id: true, name: true } } },
        });
        orders = rows;
      }
      return {
        orders,
        customers: may('customer.read')
          ? await tx.customer.findMany({ where: { name }, orderBy: { name: 'asc' }, take: SEARCH_LIMIT, select: { id: true, name: true } })
          : [],
        partners: may('partner.read')
          ? await tx.partner.findMany({
              where: { OR: [{ name }, { displayName: name }] },
              orderBy: { name: 'asc' },
              take: SEARCH_LIMIT,
              select: { id: true, name: true },
            })
          : [],
        articles: await tx.knowledgeArticle.findMany({
          where: { status: 'published', title: name },
          orderBy: { title: 'asc' },
          take: SEARCH_LIMIT,
          select: { id: true, title: true },
        }),
      };
    });
  }
}
