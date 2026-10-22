import { Readable } from 'node:stream';
import { cube, stl } from '../../../test/stl';
import { DEFAULT_MEASURERS, MEASURE_TYPES, MEASURE_UNITS, measurerFor, NoopMeasurer } from './measurers';
import type { Measurer } from './measurers';

/**
 * A small sample per content type a registered measurer claims, with the
 * unit it declares. A measurer added without a fixture here fails the
 * contract test until it gets one.
 */
const stlCube = stl(cube(10), 'binary');
const FIXTURES: Record<string, { body: Buffer; declaredUnit: string | null }> = {
  '*/*': { body: Buffer.from('any bytes at all'), declaredUnit: null },
  'model/stl': { body: stlCube, declaredUnit: 'mm' },
  'application/sla': { body: stlCube, declaredUnit: 'mm' },
  'application/vnd.ms-pki.stl': { body: stlCube, declaredUnit: 'mm' },
};

const DECIMAL = /^-?\d+(\.\d+)?$/;

describe('measurer contract', () => {
  for (const measurer of DEFAULT_MEASURERS) {
    for (const contentType of measurer.contentTypes) {
      it(`${measurer.name} on ${contentType} returns known types and units, and decimal strings`, async () => {
        const fixture = FIXTURES[contentType];
        expect(fixture).toBeDefined();

        const measures = await measurer.measure({
          contentType,
          declaredUnit: fixture.declaredUnit,
          read: () => Promise.resolve(Readable.from([fixture.body])),
        });

        for (const measure of measures) {
          expect(MEASURE_TYPES).toContain(measure.type);
          expect(MEASURE_UNITS).toContain(measure.unit);
          expect(measure.value).toMatch(DECIMAL);
        }
        expect(new Set(measures.map((measure) => measure.type)).size).toBe(measures.length);
      });
    }
  }

  it('ships the no-op measurer for every type', () => {
    expect(DEFAULT_MEASURERS.some((measurer) => measurer.contentTypes.includes('*/*'))).toBe(true);
  });
});

describe('measurerFor', () => {
  const named = (name: string, contentTypes: string[]): Measurer => ({
    name,
    contentTypes,
    measure: () => Promise.resolve([]),
  });
  const exact = named('png', ['image/png']);
  const family = named('images', ['image/*']);
  const fallback = new NoopMeasurer();
  const all = [fallback, family, exact];

  it('prefers an exact type, then type/*, then */*', () => {
    expect(measurerFor('image/png', all)).toBe(exact);
    expect(measurerFor('image/jpeg', all)).toBe(family);
    expect(measurerFor('application/pdf', all)).toBe(fallback);
  });

  it('ignores letter case', () => {
    expect(measurerFor('Image/PNG', all)).toBe(exact);
  });

  it('refuses a registry with nothing that matches', () => {
    expect(() => measurerFor('application/pdf', [exact, family])).toThrow(/application\/pdf/);
  });
});
