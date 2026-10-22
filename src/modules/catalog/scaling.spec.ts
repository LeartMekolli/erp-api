import { ZodError } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import type { MeasureType } from '../files/measurers';
import { parseScale, scaleMeasures } from './scaling';

const dec = (value: string) => new Prisma.Decimal(value);
const measure = (type: MeasureType, value: string, unit: string) => ({ type, value: dec(value), unit });

describe('scaleMeasures', () => {
  it('scales lengths by s, areas by s² and volumes by s³, rounded to 6 places', () => {
    const scaled = scaleMeasures(
      [
        measure('volume', '1000', 'mm3'),
        measure('surface_area', '600', 'mm2'),
        measure('bounding_box_x', '10', 'mm'),
        measure('width', '20', 'mm'),
        measure('page_count', '3', 'count'),
      ],
      dec('1.5'),
    );
    expect(Object.fromEntries(scaled.map((m) => [m.type, m.value.toFixed(6)]))).toEqual({
      volume: '3375.000000',
      surface_area: '1350.000000',
      bounding_box_x: '15.000000',
      width: '30.000000',
      page_count: '3.000000',
    });
    expect(scaled.map((m) => m.unit)).toEqual(['mm3', 'mm2', 'mm', 'mm', 'count']);
  });

  it('rounds a long result to six places', () => {
    expect(scaleMeasures([measure('volume', '1', 'mm3')], dec('1.1111'))[0].value.toFixed()).toBe('1.371701');
  });
});

describe('parseScale', () => {
  it('reads a plain decimal', () => {
    expect(parseScale('1.5').toFixed()).toBe('1.5');
    expect(parseScale('0.01').toFixed()).toBe('0.01');
    expect(parseScale('100').toFixed()).toBe('100');
  });

  it.each(['1e3', '-1', '0', '0.00', '1.12345', '', ' 1', '100.0001', '1,5'])('rejects %j', (value) => {
    expect(() => parseScale(value)).toThrow(ZodError);
  });
});
