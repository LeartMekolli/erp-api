import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import { paginationQuerySchema, toPage } from '../../common/pagination/page';
import type { Page, PaginationQuery } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { CustomerAuth, TenantAuth } from '../identity/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import { reduceOwed } from '../partners/owed-reduction';
import { CreditNotesService } from '../payments/credit-notes.service';
import { RefundsService } from '../payments/refunds.service';
import { keySchema } from '../pricing/decimals';
import { SettingsService } from '../settings/settings.service';
import { CLAIM_FAULTS, CLAIM_OUTCOMES, CLAIM_STATES } from './claim-response';
import type { ClaimResponse, ClaimState, CustomerClaimResponse } from './claim-response';
import { claimSettings, reasonNamed } from './claim-settings';
import type { ClaimSettings } from './claim-settings';

type Tx = Prisma.TransactionClient;

const DAY_MS = 86_400_000;
/** At most this many photos a claim (CHECK in the migration). */
export const CLAIM_MAX_PHOTOS = 10;

export const openClaimSchema = z.strictObject({
  /** A key of the workspace's `orders.claims` reasons. */
  reason: keySchema,
  description: z.string().trim().min(1).max(5000),
  /** Each line once, by its position on the order, with how many of its pieces are claimed. */
  lines: z
    .array(z.strictObject({ position: z.number().int().min(0), pieces: z.number().int().min(1) }))
    .min(1)
    .max(100)
    .refine((lines) => new Set(lines.map((line) => line.position)).size === lines.length, { message: 'each line once' }),
  photo_file_version_ids: z.array(z.uuid()).max(CLAIM_MAX_PHOTOS).optional(),
});
export type OpenClaim = z.infer<typeof openClaimSchema>;

export const claimListQuerySchema = paginationQuerySchema.extend({
  state: z.enum(CLAIM_STATES).optional(),
  /** Claims with a line decided at this fault. */
  fault: z.enum(CLAIM_FAULTS).optional(),
  /** Claims with a line at this workshop's fault. */
  partner_id: z.uuid().optional(),
  customer_id: z.uuid().optional(),
});
export type ClaimListQuery = z.infer<typeof claimListQuerySchema>;

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

/** One claimed line decided: whose fault, and a remake, a refund or a refusal (goal 3). */
export const decideLineSchema = z
  .strictObject({
    fault: z.enum(CLAIM_FAULTS),
    outcome: z.enum(CLAIM_OUTCOMES),
    /** Staff's own; never shown to the customer. */
    note: z.string().trim().min(1).max(5000).optional(),
    /** Shown to the customer; required for a refusal. */
    customer_reason: z.string().trim().min(1).max(2000).optional(),
    /** Required for a refund, tax included: at most the claimed pieces' share of the line. */
    refund_amount: z
      .string()
      .regex(MONEY, 'must be an amount with at most 2 places, such as 12.50')
      .refine((value) => !MONEY.test(value) || new Prisma.Decimal(value).greaterThan(0), 'must be greater than 0')
      .optional(),
  })
  .superRefine((decision, ctx) => {
    if ((decision.outcome === 'refund') !== (decision.refund_amount !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'a refund, and only a refund, names its amount', path: ['refund_amount'] });
    }
    if (decision.outcome === 'refuse' && decision.customer_reason === undefined) {
      ctx.addIssue({ code: 'custom', message: 'a refusal tells the customer why', path: ['customer_reason'] });
    }
  });
export type DecideLine = z.infer<typeof decideLineSchema>;

/** How the customer is told of each outcome. */
const OUTCOME_WORDS = { refund: 'refunded', refuse: 'refused', remake: 'made again' } as const;

const WITH = {
  order: { select: { id: true, number: true } },
  lines: {
    orderBy: { orderLine: { position: 'asc' } },
    include: { orderLine: { select: { id: true, position: true, product: { select: { name: true } } } } },
  },
  photos: { orderBy: { position: 'asc' }, select: { fileVersionId: true } },
  shipment: true,
} satisfies Prisma.ClaimInclude;
type Claim = Prisma.ClaimGetPayload<{ include: typeof WITH }>;

interface Opener {
  tenantId: string;
  userId: string;
  kind: 'staff' | 'customer';
  /** The customer's people claim only on its orders, with photos of its own. */
  customerId?: string;
}

/**
 * Claims after delivery (Orders 3 spec, goals 1, 2 and 7). Staff and the customer's people read the same
 * rows; the customer's view leaves out whose fault staff found and their note.
 */
@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly refunds: RefundsService,
    private readonly creditNotes: CreditNotesService,
  ) {}

  async staffOpen(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, orderId: string, input: OpenClaim): Promise<ClaimResponse> {
    const { claim, settings } = await this.open({ tenantId: auth.tenantId, userId: auth.userId, kind: 'staff' }, orderId, input);
    return staffView(claim, settings);
  }

  async customerOpen(auth: CustomerAuth, orderId: string, input: OpenClaim): Promise<CustomerClaimResponse> {
    const opener: Opener = { tenantId: auth.tenantId, userId: auth.userId, kind: 'customer', customerId: auth.customerId };
    const { claim, settings } = await this.open(opener, orderId, input);
    return customerView(claim, settings);
  }

  /** Every claim, newest first, filtered. */
  list(tenantId: string, query: ClaimListQuery): Promise<Page<ClaimResponse>> {
    const where: Prisma.ClaimWhereInput[] = [];
    if (query.state) where.push(stateWhere(query.state));
    if (query.fault) where.push({ lines: { some: { fault: query.fault } } });
    if (query.partner_id) where.push({ lines: { some: { partnerId: query.partner_id } } });
    if (query.customer_id) where.push({ order: { customerId: query.customer_id } });
    return this.page(tenantId, { AND: where }, query, staffView);
  }

  get(tenantId: string, id: string): Promise<ClaimResponse> {
    return this.one(tenantId, { id }, staffView);
  }

  /** The customer's own claims, newest first. */
  customerList(auth: CustomerAuth, query: PaginationQuery): Promise<Page<CustomerClaimResponse>> {
    return this.page(auth.tenantId, { order: { customerId: auth.customerId } }, query, customerView);
  }

  customerGet(auth: CustomerAuth, id: string): Promise<CustomerClaimResponse> {
    return this.one(auth.tenantId, { id, order: { customerId: auth.customerId } }, customerView);
  }

  /** Staff ask for the pieces back: the claim waits for them (goal 2). 409 once asked, or with every line decided. */
  requestReturn(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, id: string): Promise<ClaimResponse> {
    return this.change(auth, id, (claim) => {
      if (claim.returnRequestedAt) throw new ConflictException('The pieces were asked back already');
      if (claim.lines.every((line) => line.outcome !== null)) throw new ConflictException('Every line of this claim is decided');
      return { returnRequestedAt: new Date() };
    });
  }

  /** Staff received the pieces asked back: the claim is open for decisions again. */
  markReturned(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, id: string): Promise<ClaimResponse> {
    return this.change(auth, id, (claim) => {
      if (!claim.returnRequestedAt) throw new ConflictException('The pieces were not asked back');
      if (claim.returnedAt) throw new ConflictException('The pieces were received already');
      return { returnedAt: new Date() };
    });
  }

  /**
   * Decides one claimed line, once (goal 3). The order, the claim and the line are locked in that order,
   * so two decisions at once take turns and the second finds the line decided (409). A refund needs
   * `payment.refund`, and is at most the claimed pieces' share of the line with tax; it gives back what was
   * paid and credits the rest on the open invoice, both asked for after the commit. A workshop at fault is owed its cost for those pieces less, or the
   * line records the shortfall.
   */
  async decide(auth: Pick<TenantAuth, 'tenantId' | 'userId' | 'permissions'>, claimId: string, lineId: string, input: DecideLine): Promise<ClaimResponse> {
    if (input.outcome === 'refund' && !auth.permissions.has('payment.refund')) {
      throw new ForbiddenException('Refunding needs payment.refund');
    }
    const { view, afterCommit } = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const found = await tx.claimLine.findFirst({ where: { id: lineId, claimId }, select: { claim: { select: { orderId: true } } } });
      if (!found) throw new NotFoundException('Claim line not found');
      await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${found.claim.orderId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM claim WHERE id = ${claimId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM claim_line WHERE id = ${lineId}::uuid FOR UPDATE`;

      const claim = await tx.claim.findUniqueOrThrow({ where: { id: claimId }, include: { order: true } });
      const line = await tx.claimLine.findUniqueOrThrow({ where: { id: lineId }, include: { orderLine: true } });
      if (line.outcome !== null) throw new ConflictException('This line is decided already');
      if (claim.returnRequestedAt && !claim.returnedAt) throw new ConflictException('The claim waits for the pieces asked back');
      if (input.outcome === 'remake') {
        throw new BadRequestException({ message: 'Remakes are not available yet', errors: [{ path: 'outcome', message: 'not available yet' }] });
      }

      const workshop = input.fault === 'workshop' ? await this.workshopOf(tx, line.orderLine.groupId) : null;
      const steps: (() => Promise<void>)[] = [];
      let refundAmount: Prisma.Decimal | null = null;
      // The schema holds an amount exactly for a refund.
      if (input.outcome === 'refund' && input.refund_amount) {
        refundAmount = new Prisma.Decimal(input.refund_amount);
        const most = line.orderLine.total
          .mul(line.pieces)
          .div(line.orderLine.quantity)
          .mul(claim.order.taxPercent.div(100).add(1))
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        if (refundAmount.gt(most)) {
          throw new BadRequestException({
            message: `At most ${most.toFixed(2)} can be refunded for these pieces`,
            errors: [{ path: 'refund_amount', message: `at most ${most.toFixed(2)}` }],
          });
        }
        // What was paid is given back; the rest is credited on the open invoice (O3-11). Beyond both, a 409.
        const paidLeft = Prisma.Decimal.max(0, await this.refunds.paidLeft(tx, claim.orderId));
        const refundPart = Prisma.Decimal.min(refundAmount, paidLeft);
        const creditPart = refundAmount.sub(refundPart);
        if (creditPart.gt(await this.creditNotes.creditable(tx, claim.orderId))) {
          throw new ConflictException(`Only ${paidLeft.toFixed(2)} paid can be refunded, and the rest only up to what is open on the invoice`);
        }
        if (refundPart.gt(0)) {
          const refundId = await this.refunds.create(tx, { orderId: claim.orderId, amount: refundPart, reason: `Claim ${claim.number}`, userId: auth.userId });
          steps.push(() => this.refunds.afterCreate(auth.tenantId, refundId));
        }
        if (creditPart.gt(0)) {
          const creditNoteId = await this.creditNotes.create(tx, { orderId: claim.orderId, claimLineId: lineId, amount: creditPart });
          if (!creditNoteId) throw new ConflictException('Nothing is open on the invoice to credit');
          steps.push(() => this.creditNotes.afterCreate(auth.tenantId, creditNoteId));
        }
      }

      // The workshop at fault is owed its cost for the claimed pieces less (goal 5).
      let owed: { reduced: Prisma.Decimal; shortfall: Prisma.Decimal } | null = null;
      if (workshop && input.outcome === 'refund') {
        const share = workshop.cost.mul(line.pieces).div(workshop.quantity).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        owed = await reduceOwed(tx, workshop.assignmentId, share, `Claim ${claim.number}: ${line.pieces} pieces refunded at the workshop's fault`);
      }

      const settings = await claimSettings(tx, this.settings);
      const before = staffView(await tx.claim.findUniqueOrThrow({ where: { id: claimId }, include: WITH }), settings);
      await tx.claimLine.update({
        where: { id: lineId },
        data: {
          fault: input.fault,
          outcome: input.outcome,
          note: input.note ?? null,
          customerReason: input.customer_reason ?? null,
          refundAmount,
          partnerId: workshop?.partnerId ?? null,
          owedReduction: owed?.reduced ?? null,
          shortfall: owed && owed.shortfall.gt(0) ? owed.shortfall : null,
          decidedByUserId: auth.userId,
          decidedAt: new Date(),
        },
      });
      const after = staffView(await tx.claim.findUniqueOrThrow({ where: { id: claimId }, include: WITH }), settings);
      await this.audit.record(tx, { actor: { type: 'user', id: auth.userId }, action: 'claim.changed', subject: { type: 'claim', id: claimId }, before, after });
      const notificationId = await this.notifications.store(
        tx,
        'claim.decided',
        { type: 'order', id: claim.orderId },
        { number: String(claim.number), order_number: String(claim.order.number), outcome: OUTCOME_WORDS[input.outcome], reason: input.customer_reason ?? '' },
      );
      steps.push(() => this.notifications.queue(auth.tenantId, notificationId));
      return { view: after, afterCommit: steps };
    });
    for (const step of afterCommit) {
      try {
        await step();
      } catch (error) {
        this.logger.error({ err: error, claimId, lineId }, 'a step after deciding a claim line failed');
      }
    }
    return view;
  }

  /**
   * The workshop that made a line: its group's accepted job, else the one it replaced last. A line made
   * in-house has none, and can't be at a workshop's fault (400).
   */
  private async workshopOf(
    tx: Tx,
    groupId: string | null,
  ): Promise<{ assignmentId: string; partnerId: string; cost: Prisma.Decimal; quantity: number }> {
    const jobs = groupId
      ? await tx.jobAssignment.findMany({
          where: { groupId, status: { in: ['accepted', 'replaced'] } },
          include: { group: { select: { quantity: true } } },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    const job = jobs.find((one) => one.status === 'accepted') ?? jobs[0];
    if (!job) {
      throw new BadRequestException({ message: 'No workshop made this line', errors: [{ path: 'fault', message: 'the line was made in-house' }] });
    }
    return { assignmentId: job.id, partnerId: job.partnerId, cost: job.cost, quantity: job.group.quantity };
  }

  /**
   * Opens a claim on a delivered order, within the window. The order is locked, so two claims at once
   * never claim the same pieces twice; numbers are given under a workspace-wide lock.
   */
  private async open(opener: Opener, orderId: string, input: OpenClaim): Promise<{ claim: Claim; settings: ClaimSettings }> {
    const { claim, settings, notificationId } = await this.prisma.inTenant(opener.tenantId, async (tx) => {
      const found = await tx.order.findFirst({ where: { id: orderId, ...(opener.customerId ? { customerId: opener.customerId } : {}) }, select: { id: true } });
      if (!found) throw new NotFoundException('Order not found');
      await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: {
          id: true,
          number: true,
          deliveredAt: true,
          customer: { select: { name: true } },
          lines: { select: { id: true, position: true, quantity: true, cancelledAt: true } },
        },
      });
      const settings = await claimSettings(tx, this.settings);
      if (!order.deliveredAt) throw new ConflictException('Only a delivered order can be claimed');
      if (order.deliveredAt.getTime() + settings.windowDays * DAY_MS < Date.now()) {
        throw new ConflictException(`Claims are open for ${settings.windowDays} days after delivery`);
      }
      if (!settings.reasons.some((reason) => reason.key === input.reason)) {
        throw new BadRequestException({ message: 'Name a reason of the workspace', errors: [{ path: 'reason', message: 'not a reason of orders.claims' }] });
      }
      const lines = await this.requireLines(tx, order.lines, input.lines);
      const photos = await this.requirePhotos(tx, [...new Set(input.photo_file_version_ids ?? [])], opener.customerId);

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${opener.tenantId}:claim_number`}::text, 0))`;
      const last = await tx.claim.aggregate({ _max: { number: true } });
      const created = await tx.claim.create({
        data: {
          orderId,
          number: (last._max.number ?? 0) + 1,
          reason: input.reason,
          description: input.description,
          openedByUserId: opener.userId,
          openedByKind: opener.kind,
          lines: { create: lines.map((line) => ({ orderLineId: line.orderLineId, pieces: line.pieces })) },
          photos: { create: photos.map((fileVersionId, position) => ({ fileVersionId, position })) },
        },
        include: WITH,
      });
      await this.audit.record(tx, {
        actor: { type: 'user', id: opener.userId },
        action: 'claim.changed',
        subject: { type: 'claim', id: created.id },
        after: staffView(created, settings),
      });
      const notificationId = await this.notifications.store(
        tx,
        'claim.opened',
        { type: 'order', id: orderId },
        { number: String(created.number), order_number: String(order.number), customer_name: order.customer.name },
      );
      return { claim: created, settings, notificationId };
    });
    await this.notifications.queue(opener.tenantId, notificationId);
    return { claim, settings };
  }

  /** The order's lines named by position, not cancelled, with no more pieces than are left to claim on each. */
  private async requireLines(
    tx: Tx,
    orderLines: { id: string; position: number; quantity: number; cancelledAt: Date | null }[],
    claimed: OpenClaim['lines'],
  ): Promise<{ orderLineId: string; pieces: number }[]> {
    const already = await tx.claimLine.groupBy({
      by: ['orderLineId'],
      where: { orderLineId: { in: orderLines.map((line) => line.id) } },
      _sum: { pieces: true },
    });
    const claimedBefore = new Map(already.map((row) => [row.orderLineId, row._sum.pieces ?? 0]));
    return claimed.map((wanted, index) => {
      const line = orderLines.find((one) => one.position === wanted.position);
      if (!line || line.cancelledAt) {
        throw new BadRequestException({
          message: 'Claim a line of this order that was not cancelled',
          errors: [{ path: `lines.${index}.position`, message: line ? 'cancelled' : 'not a line of this order' }],
        });
      }
      const left = line.quantity - (claimedBefore.get(line.id) ?? 0);
      if (wanted.pieces > left) {
        throw new BadRequestException({
          message: 'More pieces than are left to claim on the line',
          errors: [{ path: `lines.${index}.pieces`, message: `at most ${left}` }],
        });
      }
      return { orderLineId: line.id, pieces: wanted.pieces };
    });
  }

  /** Uploaded versions the opener may attach: the customer only its own. The first it may not is a 404 naming it. */
  private async requirePhotos(tx: Tx, ids: string[], customerId: string | undefined): Promise<string[]> {
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
        throw new NotFoundException({ message: 'File not found', errors: [{ path: `photo_file_version_ids.${index}`, message: 'not found' }] });
      }
    }
    return ids;
  }

  /** Locks the claim, applies one change to it, audits it, and answers it as staff see it. */
  private async change(
    auth: Pick<TenantAuth, 'tenantId' | 'userId'>,
    id: string,
    apply: (claim: Claim) => Prisma.ClaimUpdateInput,
  ): Promise<ClaimResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM claim WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Claim not found');
      const settings = await claimSettings(tx, this.settings);
      const before = await tx.claim.findUniqueOrThrow({ where: { id }, include: WITH });
      const updated = await tx.claim.update({ where: { id }, data: apply(before), include: WITH });
      const after = staffView(updated, settings);
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'claim.changed',
        subject: { type: 'claim', id },
        before: staffView(before, settings),
        after,
      });
      return after;
    });
  }

  private async one<T>(tenantId: string, where: Prisma.ClaimWhereInput, view: (claim: Claim, settings: ClaimSettings) => T): Promise<T> {
    const found = await this.prisma.inTenant(tenantId, async (tx) => {
      const claim = await tx.claim.findFirst({ where, include: WITH });
      return claim ? view(claim, await claimSettings(tx, this.settings)) : null;
    });
    if (!found) throw new NotFoundException('Claim not found');
    return found;
  }

  private async page<T extends { id: string }>(
    tenantId: string,
    where: Prisma.ClaimWhereInput,
    query: PaginationQuery,
    view: (claim: Claim, settings: ClaimSettings) => T,
  ): Promise<Page<T>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    const rows = await this.prisma.inTenant(tenantId, async (tx) => {
      const claims = await tx.claim.findMany({
        where: { AND: [where, after ? { id: { lt: after.id } } : {}] },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        include: WITH,
      });
      const settings = await claimSettings(tx, this.settings);
      return claims.map((claim) => view(claim, settings));
    });
    return toPage(rows, query.limit, secret);
  }
}

/** Waiting for the pieces asked back; else open while a line is undecided; else decided until every remake is delivered. */
export function claimState(claim: Pick<Claim, 'returnRequestedAt' | 'returnedAt' | 'lines' | 'shipment'>): ClaimState {
  if (claim.returnRequestedAt && !claim.returnedAt) return 'awaiting_return';
  if (claim.lines.some((line) => line.outcome === null)) return 'open';
  const remade = claim.lines.some((line) => line.outcome === 'remake');
  return remade && !claim.shipment?.deliveredAt ? 'decided' : 'closed';
}

/** `claimState` as a query. */
function stateWhere(state: ClaimState): Prisma.ClaimWhereInput {
  const waiting: Prisma.ClaimWhereInput = { returnRequestedAt: { not: null }, returnedAt: null };
  const notWaiting: Prisma.ClaimWhereInput = { OR: [{ returnRequestedAt: null }, { returnedAt: { not: null } }] };
  const decided: Prisma.ClaimWhereInput = { lines: { none: { outcome: null } } };
  const remakeDelivered: Prisma.ClaimWhereInput = { shipment: { is: { deliveredAt: { not: null } } } };
  switch (state) {
    case 'awaiting_return':
      return waiting;
    case 'open':
      return { AND: [notWaiting, { lines: { some: { outcome: null } } }] };
    case 'decided':
      return { AND: [notWaiting, decided, { lines: { some: { outcome: 'remake' } } }, { NOT: remakeDelivered }] };
    case 'closed':
      return { AND: [notWaiting, decided, { OR: [{ lines: { none: { outcome: 'remake' } } }, remakeDelivered] }] };
  }
}

function common(claim: Claim, settings: ClaimSettings) {
  return {
    id: claim.id,
    number: claim.number,
    order: { id: claim.order.id, number: claim.order.number },
    state: claimState(claim),
    reason: reasonNamed(claim.reason, settings),
    description: claim.description,
    photos: claim.photos.map((photo) => ({ file_version_id: photo.fileVersionId })),
    return: claim.returnRequestedAt
      ? { requested_at: claim.returnRequestedAt.toISOString(), returned_at: claim.returnedAt?.toISOString() ?? null }
      : null,
    shipment: claim.shipment
      ? {
          courier: claim.shipment.courier,
          tracking: claim.shipment.tracking,
          shipped_at: claim.shipment.shippedAt.toISOString(),
          delivered_at: claim.shipment.deliveredAt?.toISOString() ?? null,
        }
      : null,
    created_at: claim.createdAt.toISOString(),
  };
}

const orderLineOf = (line: Claim['lines'][number]) => ({
  id: line.orderLine.id,
  position: line.orderLine.position,
  product_name: line.orderLine.product.name,
});

/** The decision as the customer may see it, or null while undecided. */
function shownDecision(line: Claim['lines'][number]) {
  if (line.outcome === null) return null;
  return {
    outcome: line.outcome as 'remake' | 'refund' | 'refuse',
    customer_reason: line.customerReason,
    refund_amount: line.refundAmount?.toFixed(2) ?? null,
    remake_group_id: line.remakeGroupId,
  };
}

export function staffView(claim: Claim, settings: ClaimSettings): ClaimResponse {
  return {
    ...common(claim, settings),
    lines: claim.lines.map((line) => {
      const shown = shownDecision(line);
      return {
        id: line.id,
        order_line: orderLineOf(line),
        pieces: line.pieces,
        decision: shown ? { ...shown, fault: line.fault as 'workshop' | 'workspace' | 'courier' | 'customer', note: line.note } : null,
      };
    }),
  };
}

export function customerView(claim: Claim, settings: ClaimSettings): CustomerClaimResponse {
  return {
    ...common(claim, settings),
    lines: claim.lines.map((line) => ({ id: line.id, order_line: orderLineOf(line), pieces: line.pieces, decision: shownDecision(line) })),
  };
}
