import { Readable } from 'node:stream';
import { UnrecoverableError } from 'bullmq';
import { cube, inverted, stl, tetrahedron } from '../../../test/stl';
import type { Triangle } from '../../../test/stl';
import { StlMeasurer } from './stl-measurer';

const measurer = new StlMeasurer();

async function measure(file: Buffer, declaredUnit: string | null): Promise<Record<string, string>> {
  const measures = await measurer.measure({
    contentType: 'model/stl',
    declaredUnit,
    read: () => Promise.resolve(Readable.from([file])),
  });
  for (const measure of measures) {
    expect(measure.unit).toBe(measure.type === 'volume' ? 'mm3' : measure.type === 'surface_area' ? 'mm2' : 'mm');
  }
  return Object.fromEntries(measures.map((measure) => [measure.type, measure.value]));
}

function broken(kind: string): Buffer {
  const valid = stl(cube(10), 'binary');
  switch (kind) {
    case 'empty':
      return Buffer.alloc(0);
    case 'truncated':
      return valid.subarray(0, valid.length - 10);
    default: {
      const lying = Buffer.from(valid);
      lying.writeUInt32LE(1000, 80);
      return lying;
    }
  }
}

describe('StlMeasurer', () => {
  it('claims the STL content types', () => {
    expect(measurer.contentTypes).toEqual(['model/stl', 'application/sla', 'application/vnd.ms-pki.stl']);
  });

  it('measures a 10 mm cube from binary and ASCII alike', async () => {
    for (const format of ['binary', 'ascii'] as const) {
      expect(await measure(stl(cube(10), format), 'mm')).toEqual({
        volume: '1000.000000',
        surface_area: '600.000000',
        bounding_box_x: '10.000000',
        bounding_box_y: '10.000000',
        bounding_box_z: '10.000000',
      });
    }
  });

  it('measures a tetrahedron', async () => {
    // Vertices (0,0,0) (6,0,0) (0,6,0) (0,0,6): volume 36, area 54 + 18√3.
    const measures = await measure(stl(tetrahedron(6), 'binary'), 'mm');
    expect(measures.volume).toBe('36.000000');
    expect(Number(measures.surface_area)).toBeCloseTo(54 + 18 * Math.sqrt(3), 5);
  });

  it('subtracts an inner cavity', async () => {
    // A 10 mm cube with an inward-facing 4 mm cube inside: 1000 - 64.
    const measures = await measure(stl([...cube(10), ...inverted(cube(4, 3))], 'binary'), 'mm');
    expect(measures.volume).toBe('936.000000');
    expect(measures.surface_area).toBe('696.000000');
  });

  it('honours the declared unit', async () => {
    expect(await measure(stl(cube(1), 'binary'), 'cm')).toMatchObject({
      volume: '1000.000000',
      surface_area: '600.000000',
      bounding_box_x: '10.000000',
    });
    expect((await measure(stl(cube(1), 'binary'), 'in')).bounding_box_x).toBe('25.400000');
  });

  it('refuses a file without a declared unit', async () => {
    await expect(measure(stl(cube(10), 'binary'), null)).rejects.toThrow(/STL.*unit/);
  });

  it.each(['empty', 'truncated', 'count larger than the file'])('refuses a broken STL: %s', async (kind) => {
    await expect(measure(broken(kind), 'mm')).rejects.toThrow(UnrecoverableError);
    await expect(measure(broken(kind), 'mm')).rejects.toThrow(/STL/);
  });

  it('refuses a binary STL holding values that are not numbers', async () => {
    const file = stl(cube(10), 'binary');
    file.writeFloatLE(Number.NaN, 84 + 12);
    await expect(measure(file, 'mm')).rejects.toThrow(/STL: .*not numbers/);
  });

  it('refuses a flat mesh that encloses no volume', async () => {
    // Two triangles back to back: a surface, but nothing inside it.
    const flat: Triangle[] = [
      [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
      [[0, 0, 0], [0, 10, 0], [10, 0, 0]],
    ];
    await expect(measure(stl(flat, 'binary'), 'mm')).rejects.toThrow(/STL: .*no volume/);
  });

  it('refuses a model too large for its declared unit', async () => {
    await expect(measure(stl(cube(100_000), 'binary'), 'm')).rejects.toThrow(/STL: .*too large/);
  });
});
