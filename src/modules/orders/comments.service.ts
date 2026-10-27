import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import { toPage } from '../../common/pagination/page';
import type { Page, PaginationQuery } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { FilesService } from '../files/files.service';
import type { CustomerAuth, PartnerAuth, TenantAuth } from '../identity/auth-context';
import { COMMENT_MAX_ATTACHMENTS, COMMENT_MAX_LENGTH } from './order-response';
import type { CustomerOrderCommentResponse, OrderCommentResponse } from './order-response';
import type { PartnerJobCommentResponse } from '../partners/partner-response';

type Tx = Prisma.TransactionClient;

const body = z.string().trim().min(1).max(COMMENT_MAX_LENGTH);
const attachments = z.array(z.uuid()).max(COMMENT_MAX_ATTACHMENTS).optional();

/** Staff write on the order or a line; `for_partner` sends a line's comment to the partner holding it. */
export const staffCommentSchema = z
  .strictObject({ body, line_id: z.uuid().optional(), for_partner: z.boolean().optional(), attachments })
  .refine((comment) => !comment.for_partner || comment.line_id !== undefined, {
    message: 'A comment for the partner needs a line',
    path: ['for_partner'],
  });
export type StaffComment = z.infer<typeof staffCommentSchema>;

/** The customer's people write on the order or a line, and never to a partner. */
export const customerCommentSchema = z.strictObject({ body, line_id: z.uuid().optional(), attachments });
export type CustomerComment = z.infer<typeof customerCommentSchema>;

/** A partner writes text only. */
export const partnerCommentSchema = z.strictObject({ body });
export type PartnerComment = z.infer<typeof partnerCommentSchema>;

/** What a reader may see, and the line a partner's own comment is on. */
interface Scope {
  orderId: string;
  where: Prisma.OrderCommentWhereInput;
  lineId?: string;
}

interface Draft {
  authorUserId: string;
  authorKind: 'staff' | 'customer' | 'partner';
  partnerId?: string;
  body: string;
  lineId?: string;
  forPartner?: boolean;
  attachments?: string[];
  /** The only files the author may attach: a customer's own. Staff attach any file of the workspace. */
  ownedByCustomer?: string;
}

const WITH = {
  author: { select: { name: true } },
  attachments: { orderBy: { position: 'asc' }, include: { fileVersion: { select: { originalName: true } } } },
} satisfies Prisma.OrderCommentInclude;
type Comment = Prisma.OrderCommentGetPayload<{ include: typeof WITH }>;

/**
 * Comments on orders (Orders spec, goal 13). Three audiences read the same rows through their own filter,
 * so a reader never sees more than its filter lets through: staff everything; the customer what staff wrote
 * for it and what its people wrote; a partner only what staff marked for it on a job it holds now, and its own.
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly config: ConfigService,
  ) {}

  staffList(tenantId: string, orderId: string, query: PaginationQuery): Promise<Page<OrderCommentResponse>> {
    return this.list(tenantId, query, (tx) => this.staffScope(tx, orderId), staffView);
  }

  staffPost(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, orderId: string, input: StaffComment): Promise<OrderCommentResponse> {
    const draft: Draft = {
      authorUserId: auth.userId,
      authorKind: 'staff',
      body: input.body,
      lineId: input.line_id,
      forPartner: input.for_partner ?? false,
      attachments: input.attachments,
    };
    return this.post(auth.tenantId, (tx) => this.staffScope(tx, orderId), draft, staffView);
  }

  staffUrl(tenantId: string, orderId: string, commentId: string, fileVersionId: string) {
    return this.url(tenantId, (tx) => this.staffScope(tx, orderId), commentId, fileVersionId);
  }

  customerList(auth: CustomerAuth, orderId: string, query: PaginationQuery): Promise<Page<CustomerOrderCommentResponse>> {
    return this.list(auth.tenantId, query, (tx) => this.customerScope(tx, auth.customerId, orderId), customerView);
  }

  customerPost(auth: CustomerAuth, orderId: string, input: CustomerComment): Promise<CustomerOrderCommentResponse> {
    const draft: Draft = {
      authorUserId: auth.userId,
      authorKind: 'customer',
      body: input.body,
      lineId: input.line_id,
      attachments: input.attachments,
      ownedByCustomer: auth.customerId,
    };
    return this.post(auth.tenantId, (tx) => this.customerScope(tx, auth.customerId, orderId), draft, customerView);
  }

  customerUrl(auth: CustomerAuth, orderId: string, commentId: string, fileVersionId: string) {
    return this.url(auth.tenantId, (tx) => this.customerScope(tx, auth.customerId, orderId), commentId, fileVersionId);
  }

  partnerList(auth: PartnerAuth, groupId: string, query: PaginationQuery): Promise<Page<PartnerJobCommentResponse>> {
    return this.list(auth.tenantId, query, (tx) => this.partnerScope(tx, auth, groupId), partnerView);
  }

  partnerPost(auth: PartnerAuth, groupId: string, input: PartnerComment): Promise<PartnerJobCommentResponse> {
    const draft: Draft = { authorUserId: auth.userId, authorKind: 'partner', partnerId: auth.partnerId, body: input.body };
    return this.post(auth.tenantId, (tx) => this.partnerScope(tx, auth, groupId), draft, partnerView);
  }

  partnerUrl(auth: PartnerAuth, groupId: string, commentId: string, fileVersionId: string) {
    return this.url(auth.tenantId, (tx) => this.partnerScope(tx, auth, groupId), commentId, fileVersionId);
  }

  /** Oldest first, a page at a time. */
  private async list<T>(tenantId: string, query: PaginationQuery, scope: (tx: Tx) => Promise<Scope>, view: (comment: Comment) => T): Promise<Page<T>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(tenantId, async (tx) => {
      const { orderId, where } = await scope(tx);
      const rows = await tx.orderComment.findMany({
        where: { AND: [{ orderId }, where, after ? { id: { gt: after.id } } : {}] },
        orderBy: { id: 'asc' },
        take: query.limit + 1,
        include: WITH,
      });
      const page = toPage(rows, query.limit, secret);
      return { data: page.data.map(view), next_cursor: page.next_cursor };
    });
  }

  private post<T>(tenantId: string, scope: (tx: Tx) => Promise<Scope>, draft: Draft, view: (comment: Comment) => T): Promise<T> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const found = await scope(tx);
      const lineId = found.lineId ?? draft.lineId;
      if (lineId && !found.lineId) {
        await this.requireLine(tx, found.orderId, lineId);
      }
      const files = await this.requireFiles(tx, [...new Set(draft.attachments ?? [])], draft.ownedByCustomer);
      const created = await tx.orderComment.create({
        data: {
          orderId: found.orderId,
          lineId: lineId ?? null,
          authorUserId: draft.authorUserId,
          authorKind: draft.authorKind,
          partnerId: draft.partnerId ?? null,
          forPartner: draft.forPartner ?? false,
          body: draft.body,
          attachments: { create: files.map((fileVersionId, position) => ({ fileVersionId, position })) },
        },
        include: WITH,
      });
      return view(created);
    });
  }

  /** A signed link to an attachment of a comment the reader can see; any other is not found. */
  private async url(tenantId: string, scope: (tx: Tx) => Promise<Scope>, commentId: string, fileVersionId: string) {
    const version = await this.prisma.inTenant(tenantId, async (tx) => {
      const { orderId, where } = await scope(tx);
      const attachment = await tx.orderCommentAttachment.findFirst({
        where: { fileVersionId, comment: { AND: [{ id: commentId, orderId }, where] } },
        select: { fileVersion: { select: { id: true, fileId: true } } },
      });
      return attachment?.fileVersion;
    });
    if (!version) {
      throw new NotFoundException('Attachment not found');
    }
    return this.files.downloadUrl(tenantId, version.fileId, version.id);
  }

  private async staffScope(tx: Tx, orderId: string): Promise<Scope> {
    await this.requireOrder(tx, { id: orderId });
    return { orderId, where: {} };
  }

  private async customerScope(tx: Tx, customerId: string, orderId: string): Promise<Scope> {
    await this.requireOrder(tx, { id: orderId, customerId });
    return { orderId, where: { OR: [{ authorKind: 'staff', forPartner: false }, { authorKind: 'customer' }] } };
  }

  /** The partner's accepted job, found through the line it is made as; its comments are on that line only. */
  private async partnerScope(tx: Tx, auth: PartnerAuth, groupId: string): Promise<Scope> {
    const held = await tx.jobAssignment.findFirst({ where: { groupId, partnerId: auth.partnerId, status: 'accepted' }, select: { id: true } });
    const line = held ? await tx.orderLine.findFirst({ where: { groupId }, select: { id: true, orderId: true } }) : null;
    const part = held && !line ? await tx.orderLinePart.findFirst({ where: { groupId }, select: { id: true, line: { select: { orderId: true } } } }) : null;
    const found = line ? { lineId: line.id, orderId: line.orderId } : part ? { lineId: part.id, orderId: part.line.orderId } : null;
    if (!found) {
      throw new NotFoundException('Job not found');
    }
    return {
      ...found,
      where: { lineId: found.lineId, OR: [{ authorKind: 'staff', forPartner: true }, { authorKind: 'partner', partnerId: auth.partnerId }] },
    };
  }

  private async requireOrder(tx: Tx, where: Prisma.OrderWhereInput): Promise<void> {
    if (!(await tx.order.findFirst({ where, select: { id: true } }))) {
      throw new NotFoundException('Order not found');
    }
  }

  /** A line, or a sub-line of one, of this order. */
  private async requireLine(tx: Tx, orderId: string, lineId: string): Promise<void> {
    const line = await tx.orderLine.findFirst({ where: { id: lineId, orderId }, select: { id: true } });
    const part = line ? null : await tx.orderLinePart.findFirst({ where: { id: lineId, line: { orderId } }, select: { id: true } });
    if (!line && !part) {
      throw new BadRequestException({ message: 'Line not found on this order', errors: [{ path: 'line_id', message: 'not a line of this order' }] });
    }
  }

  /** Uploaded versions the author may attach, in order; the first one it may not is `attachments.N`. */
  private async requireFiles(tx: Tx, ids: string[], customerId: string | undefined): Promise<string[]> {
    for (const [index, id] of ids.entries()) {
      const version = await tx.fileVersion.findFirst({
        where: {
          id,
          status: { notIn: ['pending', 'completing'] },
          ...(customerId ? { file: { ownerType: 'customer', ownerId: customerId } } : {}),
        },
        select: { id: true },
      });
      if (!version) {
        throw new NotFoundException({ message: 'File not found', errors: [{ path: `attachments.${index}`, message: 'not found' }] });
      }
    }
    return ids;
  }
}

const filesOf = (comment: Comment) => comment.attachments.map((one) => ({ file_version_id: one.fileVersionId, name: one.fileVersion.originalName }));

function staffView(comment: Comment): OrderCommentResponse {
  return {
    id: comment.id,
    line_id: comment.lineId,
    author: { kind: comment.authorKind as OrderCommentResponse['author']['kind'], id: comment.authorUserId, name: comment.author.name },
    for_partner: comment.forPartner,
    body: comment.body,
    attachments: filesOf(comment),
    created_at: comment.createdAt.toISOString(),
  };
}

function customerView(comment: Comment): CustomerOrderCommentResponse {
  return {
    id: comment.id,
    line_id: comment.lineId,
    author: { kind: comment.authorKind as CustomerOrderCommentResponse['author']['kind'], name: comment.author.name },
    body: comment.body,
    attachments: filesOf(comment),
    created_at: comment.createdAt.toISOString(),
  };
}

function partnerView(comment: Comment): PartnerJobCommentResponse {
  const own = comment.authorKind === 'partner';
  return {
    id: comment.id,
    body: comment.body,
    author: { kind: own ? 'partner' : 'workspace', name: own ? comment.author.name : null },
    attachments: filesOf(comment),
    created_at: comment.createdAt.toISOString(),
  };
}
