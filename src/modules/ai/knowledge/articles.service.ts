import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { decodeCursor } from '../../../common/pagination/cursor';
import { toPage } from '../../../common/pagination/page';
import type { Page } from '../../../common/pagination/page';
import { ConfigService } from '../../../config/config.service';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { JobsService } from '../../../jobs/jobs.service';
import { AuditService } from '../../audit/audit.service';
import type { TenantAuth } from '../../identity/auth-context';
import { ATTACHMENT_TYPES } from './article-response';
import type {
  ArticleListItem,
  ArticleListQuery,
  ArticleResponse,
  ArticleStatus,
  CreateArticle,
  UpdateArticle,
} from './article-response';

type Tx = Prisma.TransactionClient;

/** Versions a file's content may be read from: uploaded, and measured for designs. */
export const READABLE_VERSIONS = ['uploaded', 'measured'];

const ARTICLE_INCLUDE = {
  createdBy: { select: { id: true, name: true } },
  attachments: {
    orderBy: { position: 'asc' },
    select: {
      file: {
        select: {
          id: true,
          name: true,
          versions: { where: { status: { in: READABLE_VERSIONS } }, orderBy: { number: 'desc' }, take: 1, select: { contentType: true } },
        },
      },
    },
  },
} as const satisfies Prisma.KnowledgeArticleInclude;

type ArticleRow = Prisma.KnowledgeArticleGetPayload<{ include: typeof ARTICLE_INCLUDE }>;

function toResponse(row: ArticleRow): ArticleResponse {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags: row.tags,
    status: row.status as ArticleStatus,
    attachments: row.attachments.map(({ file }) => ({ file_id: file.id, name: file.name, content_type: file.versions[0]?.contentType ?? '' })),
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** What the article looked like, for the audit. */
const snapshot = (row: ArticleRow) => ({
  title: row.title,
  body: row.body,
  tags: row.tags,
  status: row.status,
  attachmentFileIds: row.attachments.map(({ file }) => file.id),
});

/**
 * Knowledge articles (AI 1 spec, goal 14): written, published and archived by staff with
 * `knowledge.write`; published ones read by every staff member. Every change is audited, and each one
 * that changes what is published queues `knowledge.index` after commit.
 */
@Injectable()
export class ArticlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
  ) {}

  async list(auth: TenantAuth, query: ArticleListQuery): Promise<Page<ArticleListItem>> {
    const after = query.cursor ? decodeCursor(query.cursor, this.config.get('APP_SECRET')) : undefined;
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.assertStaff(tx, auth);
      const rows = await tx.knowledgeArticle.findMany({
        where: {
          status: this.writes(auth) ? query.status : 'published',
          ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}),
          ...(after ? { id: { lt: after.id } } : {}),
        },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        select: { id: true, title: true, tags: true, status: true, updatedAt: true },
      });
      const page = toPage(rows, query.limit, this.config.get('APP_SECRET'));
      return {
        next_cursor: page.next_cursor,
        data: page.data.map((row) => ({
          id: row.id,
          title: row.title,
          tags: row.tags,
          status: row.status as ArticleStatus,
          updated_at: row.updatedAt.toISOString(),
        })),
      };
    });
  }

  /** A draft or an archived article is a 404 for anyone without `knowledge.write`. */
  async get(auth: TenantAuth, id: string): Promise<ArticleResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.assertStaff(tx, auth);
      return toResponse(await this.visible(tx, auth, id));
    });
  }

  async create(auth: TenantAuth, input: CreateArticle): Promise<ArticleResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      await this.checkAttachments(tx, input.attachment_file_ids);
      const created = await tx.knowledgeArticle.create({
        data: {
          title: input.title,
          body: input.body,
          tags: [...new Set(input.tags)],
          createdByUserId: auth.userId,
          attachments: { create: input.attachment_file_ids.map((fileId, position) => ({ fileId, position })) },
        },
        include: ARTICLE_INCLUDE,
      });
      await this.record(tx, auth, created.id, null, created);
      return toResponse(created);
    });
  }

  async update(auth: TenantAuth, id: string, input: UpdateArticle): Promise<ArticleResponse> {
    return this.change(auth, id, async (tx, before) => {
      if (input.attachment_file_ids) {
        await this.checkAttachments(tx, input.attachment_file_ids);
        await tx.knowledgeAttachment.deleteMany({ where: { articleId: id } });
        await tx.knowledgeAttachment.createMany({
          data: input.attachment_file_ids.map((fileId, position) => ({ articleId: id, fileId, position })),
        });
      }
      return tx.knowledgeArticle.update({
        where: { id },
        data: {
          title: input.title,
          body: input.body,
          tags: input.tags ? [...new Set(input.tags)] : undefined,
          // Touched even when only the attachments changed, so the index job runs again.
          updatedAt: new Date(),
        },
        include: ARTICLE_INCLUDE,
      }).then((after) => ({ after, reindex: before.status === 'published' }));
    });
  }

  publish(auth: TenantAuth, id: string): Promise<ArticleResponse> {
    return this.move(auth, id, 'published');
  }

  archive(auth: TenantAuth, id: string): Promise<ArticleResponse> {
    return this.move(auth, id, 'archived');
  }

  /** Publishing and archiving: a move to where it already is changes nothing. */
  private move(auth: TenantAuth, id: string, status: ArticleStatus): Promise<ArticleResponse> {
    return this.change(auth, id, async (tx, before) => {
      if (before.status === status) return { after: before, reindex: false };
      const after = await tx.knowledgeArticle.update({ where: { id }, data: { status }, include: ARTICLE_INCLUDE });
      return { after, reindex: true };
    });
  }

  private async change(
    auth: TenantAuth,
    id: string,
    apply: (tx: Tx, before: ArticleRow) => Promise<{ after: ArticleRow; reindex: boolean }>,
  ): Promise<ArticleResponse> {
    const { after, reindex } = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM knowledge_article WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await tx.knowledgeArticle.findUnique({ where: { id }, include: ARTICLE_INCLUDE });
      if (!before) throw new NotFoundException('Article not found');
      const result = await apply(tx, before);
      if (result.after !== before) await this.record(tx, auth, id, before, result.after);
      return result;
    });
    if (reindex) {
      await this.jobs.enqueue('knowledge.index', { tenantId: auth.tenantId, articleId: id, version: String(after.updatedAt.getTime()) });
    }
    return toResponse(after);
  }

  private record(tx: Tx, auth: TenantAuth, id: string, before: ArticleRow | null, after: ArticleRow) {
    return this.audit.record(tx, {
      actor: { type: 'user', id: auth.userId },
      action: 'knowledge.changed',
      subject: { type: 'knowledge_article', id },
      ...(before ? { before: snapshot(before) } : {}),
      after: snapshot(after),
    });
  }

  private writes(auth: TenantAuth): boolean {
    return auth.permissions.has('knowledge.write');
  }

  private async visible(tx: Tx, auth: TenantAuth, id: string): Promise<ArticleRow> {
    const row = await tx.knowledgeArticle.findUnique({ where: { id }, include: ARTICLE_INCLUDE });
    if (!row || (row.status !== 'published' && !this.writes(auth))) throw new NotFoundException('Article not found');
    return row;
  }

  /** Customer and partner people never read the knowledge base. */
  private async assertStaff(tx: Tx, auth: TenantAuth): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { kind: true } });
    if (user?.kind !== 'staff') throw new ForbiddenException('The knowledge base is for staff');
  }

  /** Each file is the workspace's own, with a PDF or plain text version to read. */
  private async checkAttachments(tx: Tx, fileIds: string[]): Promise<void> {
    if (new Set(fileIds).size !== fileIds.length) throw new BadRequestException('attachment_file_ids: a file is named twice');
    const files = await tx.file.findMany({
      where: { id: { in: fileIds } },
      select: { id: true, versions: { where: { status: { in: READABLE_VERSIONS } }, orderBy: { number: 'desc' }, take: 1, select: { contentType: true } } },
    });
    for (const fileId of fileIds) {
      const file = files.find((one) => one.id === fileId);
      if (!file) throw new BadRequestException(`attachment_file_ids: file ${fileId} is not of this workspace`);
      const type = file.versions[0]?.contentType;
      if (!type || !(ATTACHMENT_TYPES as readonly string[]).includes(type)) {
        throw new BadRequestException(`attachment_file_ids: file ${fileId} is not a PDF or plain text file`);
      }
    }
  }
}
