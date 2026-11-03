import type { BusinessCalendar } from '../../orders/dates';
import { planWork } from './plan';
import type { PlanGroup } from './plan';

// Monday to Friday; 2026-11-02 is a Monday.
const calendar: BusinessCalendar = { workingDays: [1, 2, 3, 4, 5], endHour: 17, closedDates: [] };
const TODAY = '2026-11-02';

let next = 0;
function group(overrides: Partial<PlanGroup> & Pick<PlanGroup, 'steps' | 'promisedOn'>): PlanGroup {
  next += 1;
  return { groupId: `g${next}`, rank: 0, startedAt: new Date(Date.UTC(2026, 9, 1, 0, next)), partnerDueOn: null, ...overrides };
}
const step = (stepId: string, pieces: number, doneBy: 'workspace' | 'partner' = 'workspace') => ({ stepId, stepTypeId: `type_${stepId}`, doneBy, pieces });

describe('planning work back from promised dates', () => {
  it('plans the last step on the promised day and the one before on the open day before, past weekends and closed dates', () => {
    const one = group({ promisedOn: '2026-11-09', steps: [step('a', 4), step('b', 4)] });
    const plan = planWork([one], new Map(), { ...calendar, closedDates: ['2026-11-06'] }, TODAY);
    expect(plan).toEqual([
      { groupId: one.groupId, stepId: 'b', stepTypeId: 'type_b', day: '2026-11-09', pieces: 4, late: false },
      { groupId: one.groupId, stepId: 'a', stepTypeId: 'type_a', day: '2026-11-05', pieces: 4, late: false },
    ]);
  });

  it('gives the day to the higher priority and splits the other across the day before', () => {
    const standard = group({ promisedOn: '2026-11-12', steps: [step('qc', 8)] });
    const gold = group({ promisedOn: '2026-11-12', rank: 2, steps: [step('qc', 8)] });
    const plan = planWork([standard, gold], new Map([['type_qc', 10]]), calendar, TODAY);
    expect(plan.filter((work) => work.groupId === gold.groupId).map((work) => [work.day, work.pieces])).toEqual([['2026-11-12', 8]]);
    expect(plan.filter((work) => work.groupId === standard.groupId).map((work) => [work.day, work.pieces])).toEqual([
      ['2026-11-12', 2],
      ['2026-11-11', 6],
    ]);
  });

  it("takes the earlier promise, then the earlier start, among equal ranks", () => {
    const later = group({ promisedOn: '2026-11-12', steps: [step('qc', 10)] });
    const sooner = group({ promisedOn: '2026-11-11', steps: [step('qc', 10)] });
    const plan = planWork([later, sooner], new Map([['type_qc', 10]]), calendar, TODAY);
    expect(plan.find((work) => work.groupId === sooner.groupId)!.day).toBe('2026-11-11');
    expect(plan.find((work) => work.groupId === later.groupId)!.day).toBe('2026-11-12');
  });

  it('puts late work on the next open day when today is closed', () => {
    // 2026-11-07 is a Saturday; the group was promised on the Friday.
    const one = group({ promisedOn: '2026-11-06', steps: [step('qc', 40)] });
    expect(planWork([one], new Map([['type_qc', 10]]), calendar, '2026-11-07')).toEqual([
      { groupId: one.groupId, stepId: 'qc', stepTypeId: 'type_qc', day: '2026-11-09', pieces: 40, late: true },
    ]);
  });

  it("plans a workshop's steps as a block ending on its job's due date, and the step before it before the block", () => {
    const one = group({
      promisedOn: '2026-11-12',
      partnerDueOn: '2026-11-06',
      steps: [step('print', 3), step('cast', 3, 'partner'), step('polish', 3, 'partner'), step('qc', 3)],
    });
    const plan = planWork([one], new Map([['type_qc', 50], ['type_cast', 1]]), calendar, TODAY);
    const dayOf = (stepId: string) => plan.find((work) => work.stepId === stepId)!.day;
    expect(dayOf('qc')).toBe('2026-11-12');
    expect(dayOf('polish')).toBe('2026-11-06');
    // A workshop's step takes no capacity of the workspace's, even of a step type with a limit.
    expect(dayOf('cast')).toBe('2026-11-05');
    expect(dayOf('print')).toBe('2026-11-04');
  });

  it('puts a passed promise on today, late, and work that no longer fits on today (Review Focus 5)', () => {
    const passed = group({ promisedOn: '2026-10-30', steps: [step('qc', 3)] });
    const crowded = group({ promisedOn: TODAY, steps: [step('qc', 30)] });
    const plan = planWork([passed, crowded], new Map([['type_qc', 10]]), { ...calendar, closedDates: ['2026-11-03'] }, TODAY);

    expect(plan.filter((work) => work.groupId === passed.groupId)).toEqual([
      { groupId: passed.groupId, stepId: 'qc', stepTypeId: 'type_qc', day: TODAY, pieces: 3, late: true },
    ]);
    const crowdedToday = plan.filter((work) => work.groupId === crowded.groupId);
    expect(crowdedToday.every((work) => work.day === TODAY)).toBe(true);
    expect(crowdedToday.reduce((sum, work) => sum + work.pieces, 0)).toBe(30);
    expect(crowdedToday.filter((work) => work.late).reduce((sum, work) => sum + work.pieces, 0)).toBeGreaterThan(0);
    expect(plan.some((work) => work.day === '2026-11-03')).toBe(false);
  });

  it('plans a step type without a capacity without a limit', () => {
    const groups = [1, 2, 3].map(() => group({ promisedOn: '2026-11-12', steps: [step('qc', 40)] }));
    const plan = planWork(groups, new Map(), calendar, TODAY);
    expect(plan.every((work) => work.day === '2026-11-12' && !work.late)).toBe(true);
  });
});
