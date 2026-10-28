import { Prisma } from '../../generated/prisma/client';
import { suggestRefund } from './refund-suggestion';

const d = (value: string) => new Prisma.Decimal(value);
const suggest = (input: { lines: string; shipping?: string; owed?: string; paidLeft: string }) => {
  const result = suggestRefund({
    cancelledLinesTotal: d(input.lines),
    shippingIfWhole: d(input.shipping ?? '0'),
    taxPercent: d('19'),
    partnersOwed: d(input.owed ?? '0'),
    paidLeft: d(input.paidLeft),
  });
  return { suggested: result.suggested.toFixed(2), workDone: result.workDone.toFixed(2) };
};

describe('suggestRefund', () => {
  it('refunds what the cancelled line cost with its tax, less the work a partner is owed for', () => {
    expect(suggest({ lines: '100.00', owed: '30.00', paidLeft: '119.00' })).toEqual({ suggested: '89.00', workDone: '30.00' });
  });

  it('includes shipping, taxed, when the whole order is cancelled', () => {
    expect(suggest({ lines: '100.00', shipping: '10.00', paidLeft: '130.90' })).toEqual({ suggested: '130.90', workDone: '0.00' });
  });

  it('suggests nothing when the work owed is worth more than the line', () => {
    expect(suggest({ lines: '100.00', owed: '150.00', paidLeft: '119.00' })).toEqual({ suggested: '0.00', workDone: '150.00' });
  });

  it('never suggests more than is left of what was paid', () => {
    expect(suggest({ lines: '100.00', paidLeft: '50.00' })).toEqual({ suggested: '50.00', workDone: '0.00' });
  });
});
