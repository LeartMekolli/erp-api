import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import type { MeasureUnit } from '../files/measurers';

/**
 * The only fixed list in the catalog besides measure types: every unit belongs
 * to one of these, and conversion never crosses them (volume to mass goes
 * through a material's density instead).
 */
export const DIMENSIONS = ['mass', 'volume', 'area', 'length', 'count'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface UnitDef {
  key: string;
  name: string;
  dimension: Dimension;
  /** How many base units of the dimension one of this unit is, as an exact decimal string. */
  factor: string;
}

/** Base units: g, mm3, mm2, mm, piece. Tenants add their own on top (spec C7). */
export const SEEDED_UNITS: readonly UnitDef[] = [
  { key: 'mm', name: 'Millimetre', dimension: 'length', factor: '1' },
  { key: 'cm', name: 'Centimetre', dimension: 'length', factor: '10' },
  { key: 'm', name: 'Metre', dimension: 'length', factor: '1000' },
  { key: 'mm2', name: 'Square millimetre', dimension: 'area', factor: '1' },
  { key: 'cm2', name: 'Square centimetre', dimension: 'area', factor: '100' },
  { key: 'mm3', name: 'Cubic millimetre', dimension: 'volume', factor: '1' },
  { key: 'cm3', name: 'Cubic centimetre', dimension: 'volume', factor: '1000' },
  { key: 'ml', name: 'Millilitre', dimension: 'volume', factor: '1000' },
  { key: 'g', name: 'Gram', dimension: 'mass', factor: '1' },
  { key: 'kg', name: 'Kilogram', dimension: 'mass', factor: '1000' },
  { key: 'toz', name: 'Troy ounce', dimension: 'mass', factor: '31.1034768' },
  { key: 'piece', name: 'Piece', dimension: 'count', factor: '1' },
];

/** Files' fixed measure units, as catalog units (spec B3); pixels and dpi have none. */
export const FILES_UNIT_TO_CATALOG: Record<MeasureUnit, string | null> = {
  mm: 'mm',
  mm2: 'mm2',
  mm3: 'mm3',
  count: 'piece',
  px: null,
  dpi: null,
};

export class DimensionMismatchError extends Error {
  constructor(from: UnitDef, to: UnitDef) {
    super(`Cannot convert ${from.key} (${from.dimension}) to ${to.key} (${to.dimension})`);
  }
}

export function convert(value: Prisma.Decimal, from: UnitDef, to: UnitDef): Prisma.Decimal {
  if (from.dimension !== to.dimension) {
    throw new DimensionMismatchError(from, to);
  }
  return value.times(from.factor).dividedBy(to.factor);
}

const PLAIN_DECIMAL = /^\d{1,9}(\.\d{1,9})?$/;

/** A positive decimal written plainly: no exponent, no sign, at most 9 decimals. */
export const positiveDecimalSchema = z
  .string()
  .regex(PLAIN_DECIMAL, 'must be a decimal such as 1.5')
  // Zod runs refinements after a failed regex too, so only parse what the regex accepted.
  .refine((value) => !PLAIN_DECIMAL.test(value) || new Prisma.Decimal(value).greaterThan(0), 'must be greater than 0');

export const createUnitSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'lowercase letters, digits and _, starting with a letter'),
  name: z.string().trim().min(1).max(100),
  dimension: z.enum(DIMENSIONS),
  factor: positiveDecimalSchema,
});

export const unitResponseSchema = z.strictObject({
  key: z.string(),
  name: z.string(),
  dimension: z.enum(DIMENSIONS),
  factor: z.string(),
  seeded: z.boolean(),
});
export type UnitResponse = z.infer<typeof unitResponseSchema>;

const seededKeys: ReadonlySet<string> = new Set(SEEDED_UNITS.map((unit) => unit.key));

@Injectable()
export class UnitsService {
  async all(tx: Prisma.TransactionClient): Promise<UnitResponse[]> {
    const own = await tx.unit.findMany({ orderBy: { key: 'asc' } });
    return [
      ...SEEDED_UNITS.map((unit) => ({ ...unit, seeded: true })),
      ...own.map((row) => ({
        key: row.key,
        name: row.name,
        dimension: row.dimension as Dimension,
        factor: row.factor.toFixed(),
        seeded: false,
      })),
    ];
  }

  /** A seeded unit or one of the tenant's; 404 otherwise. */
  async byKey(tx: Prisma.TransactionClient, key: string): Promise<UnitDef> {
    const seeded = SEEDED_UNITS.find((unit) => unit.key === key);
    if (seeded) return seeded;
    // Row-level security already limits this to the transaction's tenant.
    const row = await tx.unit.findFirst({ where: { key } });
    if (!row) {
      throw new NotFoundException(`Unknown unit ${key}`);
    }
    return { key: row.key, name: row.name, dimension: row.dimension as Dimension, factor: row.factor.toFixed() };
  }

  async create(tx: Prisma.TransactionClient, input: z.infer<typeof createUnitSchema>): Promise<UnitResponse> {
    if (seededKeys.has(input.key)) {
      throw new ConflictException(`Unit ${input.key} already exists`);
    }
    try {
      const row = await tx.unit.create({
        data: { key: input.key, name: input.name, dimension: input.dimension, factor: input.factor },
      });
      return { key: row.key, name: row.name, dimension: input.dimension, factor: row.factor.toFixed(), seeded: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Unit ${input.key} already exists`);
      }
      throw error;
    }
  }
}

