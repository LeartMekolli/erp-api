import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor } from '../../common/pagination/cursor';
import { paginationQuerySchema, toPage } from '../../common/pagination/page';
import type { Page, PaginationQuery } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { CourierAccountService } from '../couriers/courier-account.service';
import type { TrackingStatus } from '../couriers/courier-provider';
import { ShipmentsService } from '../couriers/shipments.service';
import type { Label } from '../couriers/shipments.service';
import type { CustomerAuth, TenantAuth } from '../identity/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import { labelRequestSchema } from '../orders/order-response';
import type { Address, LabelRequest } from '../orders/order-response';
import { labelResponse, labelToBuy } from '../orders/orders.service';
import type { ShipOrder } from '../orders/orders.service';
import { JobsService } from '../partners/jobs.service';
import type { Accepted, HandOver } from '../partners/jobs.service';
import { reduceOwed } from '../partners/owed-reduction';
import { CreditNotesService } from '../payments/credit-notes.service';
import { RefundsService } from '../payments/refunds.service';
import { keySchema } from '../pricing/decimals';
import { SettingsService } from '../settings/settings.service';
import { MovesService } from '../workflow/moves.service';
import { WorkOrdersService } from '../workflow/work-orders.service';
import { CLAIM_FAULTS, CLAIM_OUTCOMES, CLAIM_STATES } from './claim-response';
import type { ClaimDecisionResponse, ClaimResponse, ClaimState, CustomerClaimResponse } from './claim-response';
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

export const requestReturnSchema = z.strictObject({
  /** Buy the customer a return label to the workspace now; the pieces are asked back only once it is bought. */
  label: labelRequestSchema.optional(),
});
export type RequestReturn = z.infer<typeof requestReturnSchema>;

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

/** Shown in a notification for a courier or tracking number staff didn't give, as for an order. */
const NOT_GIVEN = '—';

const WITH = {
  order: { select: { id: true, number: true } },
  lines: {
    orderBy: { orderLine: { position: 'asc' } },
    include: { orderLine: { select: { id: true, position: true, groupId: true, product: { select: { name: true } } } } },
  },
  photos: { orderBy: { position: 'asc' }, select: { fileVersionId: true } },
  shipment: true,
  labels: { where: { status: 'bought' } },
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
export class ClaimsService implements OnModuleInit {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly refunds: RefundsService,
    private readonly creditNotes: CreditNotesService,
    private readonly workOrders: WorkOrdersService,
    private readonly jobs: JobsService,
    private readonly moves: MovesService,
    private readonly shipments: ShipmentsService,
    private readonly courierAccounts: CourierAccountService,
  ) {}

  onModuleInit(): void {
    // The courier delivered a remake's label: the claim's parcel is delivered (goal 25). A delivered return
    // label only updates its tracking: staff still mark the pieces received (goal 2).
    this.shipments.onDelivered('remake', (tenantId, shipment) => this.deliveredByCourier(tenantId, shipment.claimId!));
    // A remake's workshop at fault is never paid for it; another workshop's cost, or the workspace's own
    // work, is taken off what the first is owed (Orders 3 spec, goal 4). Partners and Workflow never depend on Claims.
    this.jobs.registerHandOverHook((tx, handOver) => this.refuseOwnRemakeAtCost(tx, handOver));
    this.jobs.registerAcceptHook((tx, accepted) => this.remadeElsewhere(tx, accepted));
    this.moves.registerPassHook((tx, passed) => this.remadeInHouse(tx, passed.groupIds));
  }

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

  /**
   * Staff ask for the pieces back: the claim waits for them (goal 2). 409 once asked, or with every line
   * decided. With `label`, the customer's return label is bought first, outside any transaction (goal 25):
   * a refusal by the courier service asks nothing back.
   */
  async requestReturn(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, id: string, body: RequestReturn): Promise<ClaimResponse> {
    const label = body.label ? await this.buyLabel(auth, id, 'return', body.label, canAskBack) : null;
    return this.change(auth, id, async (claim, tx) => {
      canAskBack(claim);
      if (label) await this.shipments.markBought(tx, label.shipmentId);
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
   * Ships the claim's remakes as its own parcel, once every remake is finished (goal 3): a claim with no
   * remake, one not finished, or shipped already, is a 409. With `label`, the label is bought first, outside
   * any transaction (goal 25), and charged to the workshop at fault when every remade line names that one.
   * The customer is told after commit.
   */
  async ship(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, id: string, body: ShipOrder): Promise<ClaimResponse> {
    const label = body.label ? await this.buyLabel(auth, id, 'remake', body.label, canShip) : null;
    const shipped = await this.change(auth, id, async (claim, tx) => {
      await canShip(claim, tx);
      if (label) {
        await this.shipments.markBought(tx, label.shipmentId);
        await this.chargeRemakeLabel(tx, claim, label);
      }
      return { shipment: { create: { courier: label?.carrier ?? body.courier ?? null, tracking: label?.tracking ?? body.tracking ?? null } } };
    });
    try {
      await this.notifications.raise(auth.tenantId, 'claim.remake_shipped', { type: 'order', id: shipped.order.id }, {
        number: String(shipped.number),
        order_number: String(shipped.order.number),
        courier: shipped.shipment?.courier ?? NOT_GIVEN,
        tracking: shipped.shipment?.tracking ?? NOT_GIVEN,
      });
    } catch (error) {
      this.logger.error({ err: error, claimId: id }, 'telling the customer of a shipped remake failed');
    }
    return shipped;
  }

  /** The claim's parcel arrived: the claim is closed. Not shipped, or delivered already, is a 409. */
  delivered(auth: Pick<TenantAuth, 'tenantId' | 'userId'>, id: string): Promise<ClaimResponse> {
    return this.change(auth, id, (claim) => {
      if (!claim.shipment) throw new ConflictException('The remakes of this claim have not shipped');
      if (claim.shipment.deliveredAt) throw new ConflictException('The remakes of this claim were delivered already');
      return { shipment: { update: { deliveredAt: new Date() } } };
    });
  }

  /**
   * The courier delivered the remake's label: the claim's parcel is delivered, by the system, as by
   * `delivered`. Delivered already, by staff or an earlier event, is left alone, so a repeat changes nothing.
   */
  async deliveredByCourier(tenantId: string, id: string): Promise<void> {
    await this.prisma.inTenant(tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM claim WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await tx.claim.findUnique({ where: { id }, include: WITH });
      if (!before?.shipment || before.shipment.deliveredAt) return;
      const settings = await claimSettings(tx, this.settings);
      const updated = await tx.claim.update({ where: { id }, data: { shipment: { update: { deliveredAt: new Date() } } }, include: WITH });
      await this.audit.record(tx, {
        actor: { type: 'system' },
        action: 'claim.changed',
        subject: { type: 'claim', id },
        before: staffView(before, settings),
        after: staffView(updated, settings),
      });
    });
  }

  /**
   * Reserves a claim's label under the claim's lock, after `check`, then buys it outside the transaction.
   * The parcel, carrier and service default to the order's shipping method's (400 when missing); no courier
   * account is a 409, a refusal by the courier service a 503. A return runs from the order's address to the
   * workspace's, a remake the other way.
   */
  private async buyLabel(
    auth: Pick<TenantAuth, 'tenantId' | 'userId'>,
    id: string,
    purpose: 'return' | 'remake',
    request: LabelRequest,
    check: (claim: Claim, tx: Tx) => void | Promise<void>,
  ): Promise<Label> {
    const reserved = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM claim WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Claim not found');
      const claim = await tx.claim.findUniqueOrThrow({ where: { id }, include: WITH });
      await check(claim, tx);
      const order = await tx.order.findUniqueOrThrow({ where: { id: claim.orderId }, select: { address: true, shippingMethodId: true } });
      const method = await tx.shippingMethod.findUniqueOrThrow({ where: { id: order.shippingMethodId } });
      const label = labelToBuy(method, request);
      const account = await this.courierAccounts.keys(tx);
      const shipmentId = await this.shipments.reserve(tx, { purpose, claimId: id, ...label, userId: auth.userId });
      const customer = order.address as Address;
      return purpose === 'return'
        ? { shipmentId, from: customer, to: account.fromAddress }
        : { shipmentId, from: account.fromAddress, to: customer };
    });
    return this.shipments.purchase(auth.tenantId, reserved.shipmentId, reserved.from, reserved.to);
  }

  /**
   * A remake's label is the workshop at fault's to bear when every remade line names that one workshop: it
   * is owed the label's cost less for the first such line's original job, recorded on the label (plan,
   * decisions). Remade lines of different workshops, or of no workshop, leave it to the workspace, as does a
   * label in another currency than the workspace's.
   */
  private async chargeRemakeLabel(tx: Tx, claim: Claim, label: Label): Promise<void> {
    const remade = claim.lines.filter((line) => line.outcome === 'remake');
    const partners = new Set(remade.map((line) => (line.fault === 'workshop' ? line.partnerId : null)));
    if (remade.length === 0 || partners.size !== 1 || partners.has(null)) return;
    const { defaultCurrency } = await tx.tenant.findUniqueOrThrow({ where: { id: claim.tenantId }, select: { defaultCurrency: true } });
    if (label.currency !== defaultCurrency) return;
    const workshop = await this.workshopOf(tx, remade[0].orderLine.groupId);
    const owed = await reduceOwed(tx, workshop.assignmentId, label.cost, `Claim ${claim.number}: the remake's label`);
    await tx.shipment.update({
      where: { id: label.shipmentId },
      data: { chargedAssignmentId: workshop.assignmentId, owedReduction: owed.reduced, shortfall: owed.shortfall.gt(0) ? owed.shortfall : null },
    });
  }

  /**
   * Decides one claimed line, once (goal 3). The order, the claim and the line are locked in that order,
   * so two decisions at once take turns and the second finds the line decided (409). A refund needs
   * `payment.refund`, and is at most the claimed pieces' share of the line with tax; it gives back what was
   * paid and credits the rest on the open invoice, both asked for after the commit. A workshop at fault is owed its cost for those pieces less, or the
   * line records the shortfall. A remake starts the claimed pieces again from the line's quote, never an
   * assembly's line (400); the workshop at fault is offered it at cost 0 when it can take it (goal 4).
   */
  async decide(
    auth: Pick<TenantAuth, 'tenantId' | 'userId' | 'permissions'>,
    claimId: string,
    lineId: string,
    input: DecideLine,
  ): Promise<ClaimDecisionResponse> {
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
      // A remade assembly would need its parts restarted too (plan, decisions).
      if (input.outcome === 'remake' && (await tx.orderLinePart.count({ where: { lineId: line.orderLineId } })) > 0) {
        throw new BadRequestException({
          message: "An assembly's line is refunded or refused, not made again",
          errors: [{ path: 'outcome', message: 'not for an assembly' }],
        });
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

      // The claimed pieces start again from the line's quote, free for the customer: nothing is billed for them.
      let remakeGroupId: string | null = null;
      if (input.outcome === 'remake') {
        const quote = await tx.quote.findUniqueOrThrow({ where: { id: line.orderLine.quoteId } });
        const started = await this.workOrders.startQuoted(tx, auth, quote, { type: 'claim_line', id: lineId }, {
          quantity: line.pieces,
          remake: { claimLineId: lineId },
        });
        remakeGroupId = started.group.id;
        steps.push(...started.afterCommit);
      }

      await tx.claimLine.update({
        where: { id: lineId },
        data: {
          fault: input.fault,
          outcome: input.outcome,
          note: input.note ?? null,
          customerReason: input.customer_reason ?? null,
          refundAmount,
          partnerId: workshop?.partnerId ?? null,
          remakeGroupId,
          owedReduction: owed?.reduced ?? null,
          shortfall: owed && owed.shortfall.gt(0) ? owed.shortfall : null,
          decidedByUserId: auth.userId,
          decidedAt: new Date(),
        },
      });

      // Back to the workshop at fault at cost 0, by a date counted from the decision just stored; if it
      // can't take it, staff hand the remake on (goal 4).
      let remake: ClaimDecisionResponse['remake'] = null;
      if (remakeGroupId) {
        remake = { group_id: remakeGroupId, unassigned_reasons: [] };
        if (workshop) {
          const offered = await this.jobs.offerRemake(tx, remakeGroupId, workshop.partnerId, auth.userId);
          if (offered.ok) {
            steps.push(() => offered.notify(auth.tenantId));
          } else {
            remake.unassigned_reasons = offered.reasons;
          }
        }
      }
      const after = staffView(await tx.claim.findUniqueOrThrow({ where: { id: claimId }, include: WITH }), settings);
      await this.audit.record(tx, { actor: { type: 'user', id: auth.userId }, action: 'claim.changed', subject: { type: 'claim', id: claimId }, before, after });
      const notificationId = await this.notifications.store(
        tx,
        'claim.decided',
        { type: 'order', id: claim.orderId },
        { number: String(claim.number), order_number: String(claim.order.number), outcome: OUTCOME_WORDS[input.outcome], reason: input.customer_reason ?? '' },
      );
      steps.push(() => this.notifications.queue(auth.tenantId, notificationId));
      return { view: { ...after, remake }, afterCommit: steps };
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

  /** A remake is never offered or moved to its workshop at fault at a cost (Global Constraints, anti-goals): a 409 on `partner_id`. */
  private async refuseOwnRemakeAtCost(tx: Tx, handOver: HandOver): Promise<void> {
    if (handOver.cost.lte(0)) return;
    const line = await tx.claimLine.findFirst({ where: { remakeGroupId: handOver.groupId }, select: { partnerId: true } });
    if (line?.partnerId === handOver.partnerId) {
      throw new ConflictException({
        message: 'The workshop at fault makes its remake at no cost',
        errors: [{ path: 'partner_id', message: 'the workshop at fault is never paid for its own remake' }],
      });
    }
  }

  /** Another workshop took the remake at a cost: the workshop at fault is owed that much less for the original job (O3-3). */
  private async remadeElsewhere(tx: Tx, accepted: Accepted): Promise<void> {
    if (accepted.cost.lte(0)) return;
    await this.reduceForRemake(tx, accepted.groupId, () => accepted.cost, (number) => `Claim ${number}: made again by another workshop`);
  }

  /**
   * The workspace makes a remake the workshop at fault didn't take: at the first pass while no workshop has
   * accepted the job, the workshop at fault is owed the claimed pieces' share of its cost less, as for a refund.
   */
  private async remadeInHouse(tx: Tx, groupIds: string[]): Promise<void> {
    const lines = await tx.claimLine.findMany({
      where: { remakeGroupId: { in: groupIds }, fault: 'workshop', owedReduction: null },
      select: { remakeGroupId: true },
    });
    for (const { remakeGroupId } of lines) {
      if (await tx.jobAssignment.findFirst({ where: { groupId: remakeGroupId!, status: 'accepted' }, select: { id: true } })) continue;
      await this.reduceForRemake(
        tx,
        remakeGroupId!,
        (workshop, pieces) => workshop.cost.mul(pieces).div(workshop.quantity).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        (number) => `Claim ${number}: made again in-house`,
      );
    }
  }

  /** Lowers what the workshop at fault is owed for the original job of a remake's line, once a line, under the line's lock. */
  private async reduceForRemake(
    tx: Tx,
    groupId: string,
    amountOf: (workshop: { cost: Prisma.Decimal; quantity: number }, pieces: number) => Prisma.Decimal,
    reasonOf: (claimNumber: number) => string,
  ): Promise<void> {
    const found = await tx.claimLine.findFirst({ where: { remakeGroupId: groupId }, select: { id: true } });
    if (!found) return;
    await tx.$queryRaw`SELECT id FROM claim_line WHERE id = ${found.id}::uuid FOR UPDATE`;
    const line = await tx.claimLine.findUniqueOrThrow({
      where: { id: found.id },
      include: { orderLine: { select: { groupId: true } }, claim: { select: { number: true } } },
    });
    if (line.fault !== 'workshop' || line.owedReduction !== null) return;
    const workshop = await this.workshopOf(tx, line.orderLine.groupId);
    const owed = await reduceOwed(tx, workshop.assignmentId, amountOf(workshop, line.pieces), reasonOf(line.claim.number));
    await tx.claimLine.update({
      where: { id: line.id },
      data: { owedReduction: owed.reduced, shortfall: owed.shortfall.gt(0) ? owed.shortfall : null },
    });
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
    apply: (claim: Claim, tx: Tx) => Prisma.ClaimUpdateInput | Promise<Prisma.ClaimUpdateInput>,
  ): Promise<ClaimResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM claim WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Claim not found');
      const settings = await claimSettings(tx, this.settings);
      const before = await tx.claim.findUniqueOrThrow({ where: { id }, include: WITH });
      const updated = await tx.claim.update({ where: { id }, data: await apply(before, tx), include: WITH });
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

/** The pieces may be asked back once, while a line is undecided; else a 409. */
function canAskBack(claim: Claim): void {
  if (claim.returnRequestedAt) throw new ConflictException('The pieces were asked back already');
  if (claim.lines.every((line) => line.outcome !== null)) throw new ConflictException('Every line of this claim is decided');
}

/** The remakes ship once, when every one of them is finished; else a 409. */
async function canShip(claim: Claim, tx: Tx): Promise<void> {
  if (claim.shipment) throw new ConflictException('The remakes of this claim have shipped already');
  const groupIds = claim.lines.flatMap((line) => (line.remakeGroupId ? [line.remakeGroupId] : []));
  if (groupIds.length === 0) throw new ConflictException('Nothing of this claim is being made again');
  if ((await tx.workOrder.count({ where: { groupId: { in: groupIds }, status: 'active' } })) > 0) {
    throw new ConflictException('Every remake of the claim must be finished before it ships');
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

/** The claim's bought label for `purpose`, if any. */
const labelOf = (claim: Claim, purpose: 'return' | 'remake') => claim.labels.find((label) => label.purpose === purpose) ?? null;

function common(claim: Claim, settings: ClaimSettings) {
  const returnLabel = labelOf(claim, 'return');
  return {
    id: claim.id,
    number: claim.number,
    order: { id: claim.order.id, number: claim.order.number },
    state: claimState(claim),
    reason: reasonNamed(claim.reason, settings),
    description: claim.description,
    photos: claim.photos.map((photo) => ({ file_version_id: photo.fileVersionId })),
    return: claim.returnRequestedAt
      ? {
          requested_at: claim.returnRequestedAt.toISOString(),
          returned_at: claim.returnedAt?.toISOString() ?? null,
          label: returnLabel
            ? { url: returnLabel.labelUrl!, tracking: returnLabel.tracking!, tracking_status: returnLabel.trackingStatus as TrackingStatus | null }
            : null,
        }
      : null,
    created_at: claim.createdAt.toISOString(),
  };
}

function shipmentOf(shipment: NonNullable<Claim['shipment']>) {
  return {
    courier: shipment.courier,
    tracking: shipment.tracking,
    shipped_at: shipment.shippedAt.toISOString(),
    delivered_at: shipment.deliveredAt?.toISOString() ?? null,
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
  const remakeLabel = labelOf(claim, 'remake');
  return {
    ...common(claim, settings),
    shipment: claim.shipment ? { ...shipmentOf(claim.shipment), label: remakeLabel ? labelResponse(remakeLabel) : null } : null,
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
    shipment: claim.shipment
      ? { ...shipmentOf(claim.shipment), tracking_status: (labelOf(claim, 'remake')?.trackingStatus ?? null) as TrackingStatus | null }
      : null,
    lines: claim.lines.map((line) => ({ id: line.id, order_line: orderLineOf(line), pieces: line.pieces, decision: shownDecision(line) })),
  };
}
