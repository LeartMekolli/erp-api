import type { Readable } from 'node:stream';
import { UnrecoverableError } from 'bullmq';
import type { Measurer, MeasureType, MeasureUnit } from './measurers';

/** Millimetres per declared unit (DECLARED_UNITS). */
const MM_PER_UNIT: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };

const BINARY_HEADER_BYTES = 84;
const BINARY_TRIANGLE_BYTES = 50;
const VERTEX = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
/** Measure columns are Decimal(18, 6): at most 12 digits before the point. */
const MAX_MEASURE = 1e12;

/** A broken file stays broken, so the job fails at once instead of retrying (the version ends `failed`). */
class StlError extends UnrecoverableError {
  constructor(problem: string) {
    super(`STL: ${problem}`);
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** Every triangle as nine numbers (three points), from a binary or ASCII STL. */
export function parseStl(file: Buffer): Float64Array {
  if (file.length === 0) {
    throw new StlError('the file is empty');
  }

  // Binary first: its 80-byte header may itself start with "solid".
  if (file.length >= BINARY_HEADER_BYTES) {
    const count = file.readUInt32LE(80);
    if (count > 0 && file.length === BINARY_HEADER_BYTES + BINARY_TRIANGLE_BYTES * count) {
      const triangles = new Float64Array(count * 9);
      for (let t = 0; t < count; t += 1) {
        const at = BINARY_HEADER_BYTES + BINARY_TRIANGLE_BYTES * t + 12; // skip the normal
        for (let i = 0; i < 9; i += 1) {
          triangles[t * 9 + i] = file.readFloatLE(at + 4 * i);
        }
      }
      if (triangles.some((value) => !Number.isFinite(value))) {
        throw new StlError('the binary triangles contain values that are not numbers');
      }
      return triangles;
    }
  }

  const text = file.toString('latin1');
  if (/^\s*solid/.test(text) && text.includes('facet')) {
    const values: number[] = [];
    for (const match of text.matchAll(VERTEX)) {
      values.push(Number(match[1]), Number(match[2]), Number(match[3]));
    }
    if (values.length === 0 || values.length % 9 !== 0 || values.some((value) => !Number.isFinite(value))) {
      throw new StlError('the ASCII triangles are incomplete or not numeric');
    }
    return Float64Array.from(values);
  }

  throw new StlError('not a binary or ASCII STL file, or it is truncated');
}

/** Volume (signed tetrahedra, so inward-facing cavities subtract), surface area and bounding box. */
export function meshMeasures(triangles: Float64Array): { volume: number; area: number; bbox: [number, number, number] } {
  let volume = 0;
  let area = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let t = 0; t < triangles.length; t += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = triangles.subarray(t, t + 9);
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;

    for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
      min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x);
      min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y);
      min[2] = Math.min(min[2], z); max[2] = Math.max(max[2], z);
    }
  }

  return { volume: Math.abs(volume), area, bbox: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Six decimals, as Measure stores; never "-0". */
function decimal(value: number): string {
  const fixed = value.toFixed(6);
  return fixed === '-0.000000' ? '0.000000' : fixed;
}

/**
 * Measures STL meshes (Q4): volume, surface area and bounding box in mm. A mesh
 * carries no unit of its own, so the file's declared unit scales it.
 */
export class StlMeasurer implements Measurer {
  readonly name = 'stl';
  readonly contentTypes = ['model/stl', 'application/sla', 'application/vnd.ms-pki.stl'];

  async measure(input: {
    contentType: string;
    declaredUnit: string | null;
    read: () => Promise<Readable>;
  }): Promise<{ type: MeasureType; value: string; unit: MeasureUnit }[]> {
    const mm = input.declaredUnit === null ? undefined : MM_PER_UNIT[input.declaredUnit];
    if (mm === undefined) {
      throw new StlError(`the file has no usable declared unit (${String(input.declaredUnit)})`);
    }

    const { volume, area, bbox } = meshMeasures(parseStl(await readAll(await input.read())));
    const volumeMm3 = volume * mm ** 3;
    if (Number(decimal(volumeMm3)) === 0) {
      throw new StlError('the mesh encloses no volume; is it closed?');
    }
    if ([volumeMm3, area * mm ** 2, ...bbox.map((side) => side * mm)].some((value) => value >= MAX_MEASURE)) {
      throw new StlError(`the model is too large in ${String(input.declaredUnit)}; check the declared unit`);
    }
    return [
      { type: 'volume', value: decimal(volumeMm3), unit: 'mm3' },
      { type: 'surface_area', value: decimal(area * mm ** 2), unit: 'mm2' },
      { type: 'bounding_box_x', value: decimal(bbox[0] * mm), unit: 'mm' },
      { type: 'bounding_box_y', value: decimal(bbox[1] * mm), unit: 'mm' },
      { type: 'bounding_box_z', value: decimal(bbox[2] * mm), unit: 'mm' },
    ];
  }
}
