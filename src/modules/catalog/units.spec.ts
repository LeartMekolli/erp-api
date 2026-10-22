import { Prisma } from '../../generated/prisma/client';
import { DimensionMismatchError, SEEDED_UNITS, convert } from './units';
import type { UnitDef } from './units';

const unit = (key: string): UnitDef => {
  const found = SEEDED_UNITS.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`No seeded unit ${key}`);
  return found;
};
const dec = (value: string) => new Prisma.Decimal(value);

describe('units', () => {
  it('seeds one base unit per dimension, with factor 1', () => {
    const bases = SEEDED_UNITS.filter((candidate) => candidate.factor === '1').map((candidate) => candidate.key);
    expect(bases).toEqual(expect.arrayContaining(['g', 'mm3', 'mm2', 'mm', 'piece']));
  });

  it('converts within a dimension exactly', () => {
    expect(convert(dec('1'), unit('toz'), unit('g')).toFixed()).toBe('31.1034768');
    expect(convert(dec('2.5'), unit('cm3'), unit('mm3')).toFixed()).toBe('2500');
    expect(convert(dec('1'), unit('ml'), unit('cm3')).toFixed()).toBe('1');
    expect(convert(dec('1500'), unit('g'), unit('kg')).toFixed()).toBe('1.5');
  });

  it('refuses to convert across dimensions', () => {
    expect(() => convert(dec('1'), unit('cm3'), unit('g'))).toThrow(DimensionMismatchError);
  });
});
