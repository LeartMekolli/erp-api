import { Prisma } from '../../generated/prisma/client';
import { planReduction } from './owed-reduction';

const d = (value: string) => new Prisma.Decimal(value);
const plain = (plan: ReturnType<typeof planReduction>) => ({
  owed: plan.owed?.toFixed(2) ?? null,
  reduced: plan.reduced.toFixed(2),
  shortfall: plan.shortfall.toFixed(2),
});

describe('lowering what a workshop at fault is owed (Orders 3 spec, goals 4 and 5)', () => {
  it('lowers what is owed while the job is not paid out', () => {
    expect(plain(planReduction({ owed: d('100.00'), paidOut: false, amount: d('20.00') }))).toEqual({ owed: '80.00', reduced: '20.00', shortfall: '0.00' });
  });

  it('never below 0: what it could not take off is a shortfall', () => {
    expect(plain(planReduction({ owed: d('15.00'), paidOut: false, amount: d('20.00') }))).toEqual({ owed: '0.00', reduced: '15.00', shortfall: '5.00' });
    expect(plain(planReduction({ owed: d('0.00'), paidOut: false, amount: d('20.00') }))).toEqual({ owed: '0.00', reduced: '0.00', shortfall: '20.00' });
  });

  it('leaves a job paid out as it is and records the whole amount as a shortfall', () => {
    expect(plain(planReduction({ owed: d('100.00'), paidOut: true, amount: d('20.00') }))).toEqual({ owed: null, reduced: '0.00', shortfall: '20.00' });
  });
});
