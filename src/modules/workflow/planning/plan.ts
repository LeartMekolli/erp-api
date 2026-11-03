import { isOpen, workingDaysBefore } from '../../orders/dates';
import type { BusinessCalendar } from '../../orders/dates';
import type { DoneBy } from '../partner-steps';

/** A live group as the planner sees it: what is left of its path, and when it is promised. */
export interface PlanGroup {
  groupId: string;
  /** `queue_rank`: higher first (Customers 2 spec, goal 17). */
  rank: number;
  promisedOn: string;
  startedAt: Date;
  /** The held job's due date, which ends a run of partner steps; null without one. */
  partnerDueOn: string | null;
  /** The remaining steps in path order, each with the active pieces at it or before it. */
  steps: { stepId: string; stepTypeId: string; doneBy: DoneBy; pieces: number }[];
}

export interface PlannedWork {
  groupId: string;
  stepId: string;
  stepTypeId: string;
  day: string;
  pieces: number;
  /** Planned on today because its day has passed or no day before it had room. */
  late: boolean;
}

/** Priority (Orders 3 spec, goal 18): the band in force first, then the earliest promise, then start order. */
export function byPriority(a: PlanGroup, b: PlanGroup): number {
  return (
    b.rank - a.rank ||
    a.promisedOn.localeCompare(b.promisedOn) ||
    a.startedAt.getTime() - b.startedAt.getTime() ||
    a.groupId.localeCompare(b.groupId)
  );
}

/**
 * Plans every group's remaining steps back from its promised date (Orders 3 spec, goals 16–17), in
 * priority order, so earlier groups keep the latest days. One open day per step:
 * - an in-house step fills the latest open day with room for its step type, from its latest day back to
 *   `today`, its pieces split across days when one is short; what doesn't fit goes on `today`, late;
 * - a run of partner steps takes no capacity: one open day each, the last on its job's due date when
 *   that is sooner;
 * - a step type without a capacity takes its latest day.
 * Work whose day has passed is on `today`, late. A guide only: nothing here moves or blocks work.
 * Answers each group's work from its last step to its first, a split step latest day first.
 */
export function planWork(groups: PlanGroup[], capacities: Map<string, number>, calendar: BusinessCalendar, today: string): PlannedWork[] {
  const used = new Map<string, number>();
  const take = (stepTypeId: string, day: string, pieces: number) => used.set(`${stepTypeId}:${day}`, (used.get(`${stepTypeId}:${day}`) ?? 0) + pieces);
  const room = (stepTypeId: string, day: string, capacity: number) => capacity - (used.get(`${stepTypeId}:${day}`) ?? 0);
  const before = (day: string) => workingDaysBefore(day, 1, calendar);
  const onOrBefore = (day: string) => (isOpen(day, calendar) ? day : before(day));

  const planned: PlannedWork[] = [];
  for (const group of [...groups].sort(byPriority)) {
    const work = (step: PlanGroup['steps'][number], day: string, pieces: number, late: boolean) =>
      planned.push({ groupId: group.groupId, stepId: step.stepId, stepTypeId: step.stepTypeId, day, pieces, late });
    let latest = onOrBefore(group.promisedOn);
    let index = group.steps.length - 1;
    while (index >= 0) {
      const step = group.steps[index];
      if (step.doneBy === 'partner') {
        let first = index;
        while (first > 0 && group.steps[first - 1].doneBy === 'partner') first -= 1;
        let day = group.partnerDueOn && group.partnerDueOn < latest ? onOrBefore(group.partnerDueOn) : latest;
        let earliest = day;
        for (let at = index; at >= first; at -= 1) {
          const late = day < today;
          earliest = late ? today : day;
          if (group.steps[at].pieces > 0) work(group.steps[at], earliest, group.steps[at].pieces, late);
          day = before(day);
        }
        latest = before(earliest);
        index = first - 1;
        continue;
      }

      let earliest = latest;
      const capacity = capacities.get(step.stepTypeId);
      if (step.pieces <= 0) {
        // Nothing left at or before this step: it holds no day.
      } else if (latest < today) {
        work(step, today, step.pieces, true);
        take(step.stepTypeId, today, step.pieces);
        earliest = today;
      } else if (capacity === undefined) {
        work(step, latest, step.pieces, false);
        take(step.stepTypeId, latest, step.pieces);
      } else {
        let left = step.pieces;
        for (let day = latest; left > 0 && day >= today; day = before(day)) {
          const free = room(step.stepTypeId, day, capacity);
          if (free <= 0) continue;
          const pieces = Math.min(free, left);
          work(step, day, pieces, false);
          take(step.stepTypeId, day, pieces);
          left -= pieces;
          earliest = day;
        }
        if (left > 0) {
          work(step, today, left, true);
          take(step.stepTypeId, today, left);
          earliest = today;
        }
      }
      latest = before(earliest);
      index -= 1;
    }
  }
  return planned;
}
