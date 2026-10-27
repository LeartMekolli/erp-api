import { Prisma } from '../../generated/prisma/client';
import { composeAssembly } from './assembly-quote';
import type { PricedPiece } from './assembly-quote';

const dec = (value: string) => new Prisma.Decimal(value);
const piece = (unitPrice: string, lines: [PricedPiece['summary'][number]['label'], string][]): PricedPiece => ({
  unitPrice: dec(unitPrice),
  summary: lines.map(([label, amount]) => ({ label, amount: dec(amount) })),
});
const plain = (result: ReturnType<typeof composeAssembly>) => ({
  unitPrice: result.unitPrice.toFixed(2),
  total: result.total.toFixed(2),
  summary: result.summary.map((line) => [line.label, line.amount.toFixed(2)]),
});

describe('composeAssembly', () => {
  // The set's own steps 4.00; a pendant at 12.50 and two bails at 1.25 go into each set.
  const own = piece('4.00', [['finishing', '4.00']]);
  const pendant = {
    ...piece('12.50', [
      ['material', '8.00'],
      ['making', '3.50'],
      ['finishing', '1.00'],
    ]),
    quantityPer: 1,
  };
  const bail = { ...piece('1.25', [['making', '1.25']]), quantityPer: 2 };

  it("prices one set as its own steps plus each part times how many go into it", () => {
    expect(plain(composeAssembly(own, [pendant, bail], 3))).toEqual({
      unitPrice: '19.00',
      total: '57.00',
      summary: [
        ['material', '8.00'],
        ['making', '6.00'],
        ['finishing', '5.00'],
      ],
    });
  });

  it("merges the parts' summary lines by label, so they still add up to the price", () => {
    const discounted = { ...piece('2.00', [['making', '2.50'], ['quantity_discount', '-0.50']]), quantityPer: 2 };
    const result = composeAssembly(own, [discounted], 1);
    expect(plain(result).summary).toEqual([
      ['making', '5.00'],
      ['finishing', '4.00'],
      ['quantity_discount', '-1.00'],
    ]);
    const sum = result.summary.reduce((total, line) => total.plus(line.amount), dec('0'));
    expect(sum.toFixed(2)).toBe(result.unitPrice.toFixed(2));
  });

  it('leaves out a label that adds up to nothing', () => {
    const credit = { ...piece('0.00', [['making', '1.00'], ['delivery_speed', '-1.00']]), quantityPer: 1 };
    const result = composeAssembly(piece('1.00', [['delivery_speed', '1.00']]), [credit], 1);
    expect(plain(result).summary).toEqual([['making', '1.00']]);
  });
});
