import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../audit/audit.service';
import { bandInForce, prioritySettings } from '../../customers/priority/bands';
import type { TenantAuth } from '../../identity/auth-context';
import { isOpen, workingDaysAfter } from '../../orders/dates';
import type { BusinessCalendar } from '../../orders/dates';
import { groupPromise, workspaceToday } from '../../orders/order-lines';
import { notWaitingForPayment } from '../../orders/payment-hold';
import { DEFAULT_CALENDAR } from '../../orders/place-order';
import { SettingsService } from '../../settings/settings.service';
import type { DoneBy } from '../partner-steps';
import { pathFor } from '../path';
import { chainOf, stepsForPath } from '../work-orders.service';
import { byPriority, planWork } from './plan';
import type { PlanGroup, PlannedWork } from './plan';
import type { PlanQuery, SetCapacity, StepCapacitiesResponse, StepCapacityResponse, StepPlanResponse } from './planning-response';

type Tx = Prisma.TransactionClient;
type Item = StepPlanResponse['planned'][number];

/** How many open days after the day `next` lists, and how far ahead days past capacity are flagged. */
const NEXT_DAYS = 5;
const FLAG_DAYS = 14;

export const overCapacitySuggestion = (pieces: number, dailyPieces: number) =>
  `${pieces} pieces planned against ${dailyPieces}: consider offering some of this work to a workshop.`;

/**
 * Production planning (Orders 3 spec, goals 16–20): each in-house step type's daily capacity, and its
 * plan for a day, computed when read from the live pieces, the capacities and the calendar. Nothing is
 * stored, so the plan follows the work as it moves; it never moves, blocks or sends out work itself.
 */
@Injectable()
export class PlanningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async capacities(tenantId: string): Promise<StepCapacitiesResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const types = await tx.stepType.findMany({ orderBy: [{ position: 'asc' }, { key: 'asc' }], include: { capacity: true } });
      return { data: types.map((type) => ({ step_type: { id: type.id, key: type.key, name: type.name }, daily_pieces: type.capacity?.dailyPieces ?? null })) };
    });
  }

  /** Sets or removes a step type's daily capacity, audited. */
  async setCapacity(auth: TenantAuth, stepTypeId: string, input: SetCapacity): Promise<StepCapacityResponse> {
    return this.prisma.inTenant(auth.tenantId, async (tx) => {
      const type = await tx.stepType.findUnique({ where: { id: stepTypeId }, include: { capacity: true } });
      if (!type) throw new NotFoundException('Step type not found');
      const before = type.capacity?.dailyPieces ?? null;
      if (input.daily_pieces === null) {
        await tx.stepCapacity.deleteMany({ where: { stepTypeId } });
      } else {
        await tx.stepCapacity.upsert({
          where: { tenantId_stepTypeId: { tenantId: auth.tenantId, stepTypeId } },
          create: { stepTypeId, dailyPieces: input.daily_pieces },
          update: { dailyPieces: input.daily_pieces },
        });
      }
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'workflow.changed',
        subject: { type: 'step_capacity', id: stepTypeId },
        before: { daily_pieces: before },
        after: { daily_pieces: input.daily_pieces },
      });
      return { step_type: { id: type.id, key: type.key, name: type.name }, daily_pieces: input.daily_pieces };
    });
  }

  /** The step type's plan for `query.date`, else for the workspace's today. */
  async forStepType(tenantId: string, query: PlanQuery): Promise<StepPlanResponse> {
    return this.prisma.inTenant(tenantId, async (tx) => {
      const type = await tx.stepType.findUnique({ where: { id: query.step_type_id }, include: { capacity: true } });
      if (!type) throw new NotFoundException('Step type not found');
      const settings = await this.settings.list(tx);
      const calendar = (settings['business.calendar'] as BusinessCalendar | undefined) ?? DEFAULT_CALENDAR;
      const today = await workspaceToday(tx, tenantId);
      const date = query.date ?? today;

      const { groups, facts } = await this.liveGroups(tx, calendar);
      const capacities = new Map((await tx.stepCapacity.findMany()).map((row) => [row.stepTypeId, row.dailyPieces]));
      const inHouse = new Set(groups.flatMap((group) => group.steps.filter((step) => step.doneBy === 'workspace').map((step) => step.stepId)));
      const work = planWork(groups, capacities, calendar, today).filter((one) => one.stepTypeId === type.id && inHouse.has(one.stepId));

      const priority = await prioritySettings(tx, this.settings);
      const bands = new Map(
        (await tx.customerPriority.findMany({ select: { customerId: true, bandKey: true, overrideBandKey: true, overrideEndsOn: true } })).map((row) => [
          row.customerId,
          row,
        ]),
      );
      const rankOf = new Map([...groups].sort(byPriority).map((group, index) => [group.groupId, index]));
      // One item per group and day: a group's two steps of one type on a day are one line of work.
      const items = (filter: (one: PlannedWork) => boolean): Item[] => {
        const merged = new Map<string, Item>();
        for (const one of work.filter(filter)) {
          const key = `${one.groupId}:${one.day}`;
          const existing = merged.get(key);
          if (existing) {
            existing.pieces += one.pieces;
            continue;
          }
          const fact = facts.get(one.groupId)!;
          const band = bandInForce(fact.customer ? (bands.get(fact.customer.id) ?? null) : null, today, priority);
          merged.set(key, { ...fact.item, band: { key: band.key, name: band.name }, pieces: one.pieces, planned_on: one.day });
        }
        return [...merged.values()].sort((a, b) => a.planned_on.localeCompare(b.planned_on) || rankOf.get(a.group_id)! - rankOf.get(b.group_id)!);
      };

      const nextUntil = workingDaysAfter(date, NEXT_DAYS, calendar);
      const daily = type.capacity?.dailyPieces ?? null;
      const overCapacity: StepPlanResponse['over_capacity'] = [];
      if (daily !== null) {
        let day = isOpen(date, calendar) ? date : workingDaysAfter(date, 1, calendar);
        for (let left = FLAG_DAYS; left > 0; left -= 1, day = workingDaysAfter(day, 1, calendar)) {
          const pieces = work.filter((one) => one.day === day).reduce((sum, one) => sum + one.pieces, 0);
          if (pieces > daily) overCapacity.push({ date: day, pieces, daily_pieces: daily, suggestion: overCapacitySuggestion(pieces, daily) });
        }
      }

      return {
        date,
        step_type: { id: type.id, key: type.key, name: type.name },
        daily_pieces: daily,
        planned: items((one) => one.day === date && !one.late),
        late: date === today ? items((one) => one.late) : [],
        next: items((one) => one.day > date && one.day <= nextUntil),
        over_capacity: overCapacity,
      };
    });
  }

  /**
   * Every live group (an active piece, an order not waiting for payment) with a promised date, as the
   * planner sees it, and what each item shows. A group that isn't an order's has no promise and isn't
   * planned.
   */
  private async liveGroups(tx: Tx, calendar: BusinessCalendar) {
    const rows = await tx.workOrderGroup.findMany({
      where: { workOrders: { some: { status: 'active' } }, ...notWaitingForPayment },
      include: {
        workOrders: { where: { status: 'active' }, select: { currentStepId: true } },
        assignments: { where: { status: 'accepted' }, select: { dueOn: true } },
        product: { select: { name: true } },
        customer: { select: { id: true, name: true } },
        orderLine: { select: { order: { select: { id: true, number: true, promisedOn: true } } } },
        orderLinePart: { select: { line: { select: { order: { select: { id: true, number: true, promisedOn: true } } } } } },
      },
    });
    const versionIds = [...new Set(rows.map((row) => row.workflowVersionId))];
    const steps = await tx.workflowStep.findMany({ where: { versionId: { in: versionIds } }, include: { stepType: true } });
    const stepById = new Map(steps.map((step) => [step.id, step]));

    const groups: PlanGroup[] = [];
    const facts = new Map<string, { customer: { id: string; name: string } | null; item: Omit<Item, 'band' | 'pieces' | 'planned_on'> }>();
    for (const row of rows) {
      const ofOrder = row.orderLine?.order ?? row.orderLinePart?.line.order ?? null;
      // An order's group is read with its order; only a remake's promise is worked out, from its claim.
      const promised =
        ofOrder?.promisedOn.toISOString().slice(0, 10) ?? (row.sourceType === 'claim_line' ? (await groupPromise(tx, row.id, calendar)).promised : null);
      if (!promised) continue;
      const path = pathFor(stepsForPath(steps.filter((step) => step.versionId === row.workflowVersionId)), chainOf(row));
      const at = row.workOrders.map((piece) => (piece.currentStepId ? path.indexOf(piece.currentStepId) : -1)).filter((index) => index >= 0);
      if (at.length === 0) continue;
      const from = Math.min(...at);
      groups.push({
        groupId: row.id,
        rank: row.queueRank,
        promisedOn: promised,
        startedAt: row.createdAt,
        partnerDueOn: row.assignments[0]?.dueOn?.toISOString().slice(0, 10) ?? null,
        steps: path.slice(from).map((stepId, offset) => {
          const step = stepById.get(stepId)!;
          return { stepId, stepTypeId: step.stepTypeId, doneBy: step.doneBy as DoneBy, pieces: at.filter((index) => index <= from + offset).length };
        }),
      });
      const order = ofOrder ? { id: ofOrder.id, number: ofOrder.number } : null;
      facts.set(row.id, {
        customer: row.customer,
        item: { group_id: row.id, order, product_name: row.product?.name ?? null, customer: row.customer, promised_on: promised },
      });
    }
    return { groups, facts };
  }
}
