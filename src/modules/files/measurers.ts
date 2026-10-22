import type { Readable } from 'node:stream';
import { StlMeasurer } from './stl-measurer';

/** Q4's list; Catalog decides which of these a product category needs. */
export const MEASURE_TYPES = [
  'width',
  'height',
  'resolution',
  'page_count',
  'volume',
  'surface_area',
  'bounding_box_x',
  'bounding_box_y',
  'bounding_box_z',
] as const;
export const MEASURE_UNITS = ['px', 'dpi', 'count', 'mm', 'mm2', 'mm3'] as const;

export type MeasureType = (typeof MEASURE_TYPES)[number];
export type MeasureUnit = (typeof MEASURE_UNITS)[number];

/**
 * Reads one file version and reports what it finds (spec 5.3). `read` opens a
 * fresh stream each call; a measurer that needs none never pays for one.
 * Values are decimal strings, so nothing is lost to floating point.
 */
export interface Measurer {
  readonly name: string;
  /** Exact types (`image/png`), families (`image/*`) or everything (`*\/*`). */
  readonly contentTypes: readonly string[];
  measure(input: {
    contentType: string;
    declaredUnit: string | null;
    read: () => Promise<Readable>;
  }): Promise<{ type: MeasureType; value: string; unit: MeasureUnit }[]>;
}

/** Measures nothing: the fallback for content types no parser claims (Q4). */
export class NoopMeasurer implements Measurer {
  readonly name = 'noop';
  readonly contentTypes = ['*/*'];

  measure(): Promise<[]> {
    return Promise.resolve([]);
  }
}

/** DI token for the registered measurers. */
export const MEASURERS = Symbol('MEASURERS');

// An exact content-type match wins, so STL files reach StlMeasurer and everything else the no-op.
export const DEFAULT_MEASURERS: readonly Measurer[] = [new StlMeasurer(), new NoopMeasurer()];

/** An exact match wins over `type/*`, which wins over `*\/*`. */
export function measurerFor(contentType: string, measurers: readonly Measurer[]): Measurer {
  const type = contentType.toLowerCase();
  const family = `${type.split('/')[0]}/*`;

  for (const candidate of [type, family, '*/*']) {
    const found = measurers.find((measurer) => measurer.contentTypes.includes(candidate));
    if (found) {
      return found;
    }
  }
  throw new Error(`No measurer registered for ${contentType}`);
}
