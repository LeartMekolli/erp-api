import { Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import { paginationQuerySchema, toPage } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { Authenticated } from '../identity/route-markers';

const listSchema = paginationQuerySchema.extend({
  unread: z.enum(['true', 'false']).optional(),
});

const idSchema = z.uuid();

export interface FeedEntry {
  id: string;
  event_key: string;
  subject: { type: string; id: string };
  title: string;
  body: string;
  created_at: Date;
  read_at: Date | null;
}

/**
 * The in-app feed (spec 6.5). Everyone reads their own, so the routes need a
 * signed-in tenant user and no permission; scope comes from the token, never
 * from an id the caller supplies (ADR 0004.5). An entry is the recipient row
 * dispatch wrote, with its title and body already rendered.
 */
@Controller('notifications')
export class FeedController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Authenticated()
  @Get()
  async list(
    @CurrentUser() auth: TenantAuth,
    @Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>,
  ): Promise<Page<FeedEntry>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;

    const rows = await this.prisma.inTenant(auth.tenantId, (tx) =>
      tx.notificationRecipient.findMany({
        where: {
          userId: auth.userId,
          ...(query.unread === 'true' ? { readAt: null } : {}),
          ...(after ? { id: { lt: after.id } } : {}),
        },
        include: { notification: { select: { eventKey: true, subjectType: true, subjectId: true } } },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      }),
    );

    const page = toPage(rows, query.limit, secret);
    return {
      data: page.data.map((row) => ({
        id: row.id,
        event_key: row.notification.eventKey,
        subject: { type: row.notification.subjectType, id: row.notification.subjectId },
        title: row.title,
        body: row.body,
        created_at: row.createdAt,
        read_at: row.readAt,
      })),
      next_cursor: page.next_cursor,
    };
  }

  /** Idempotent: an entry already read keeps its first read time. */
  @Authenticated()
  @Post(':id/read')
  @HttpCode(204)
  async markRead(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const entry = await tx.notificationRecipient.findFirst({ where: { id, userId: auth.userId } });
      if (!entry) {
        // Another user's entry looks exactly like one that does not exist.
        throw new NotFoundException('Notification not found');
      }
      await tx.notificationRecipient.updateMany({
        where: { id, userId: auth.userId, readAt: null },
        data: { readAt: new Date() },
      });
    });
  }
}
