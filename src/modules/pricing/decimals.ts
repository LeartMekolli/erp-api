import { ConflictException } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';

const AMOUNT = /^\d{1,12}(\.\d{1,6})?$/;
const PERCENT = /^-?\d{1,4}(\.\d{1,4})?$/;

/** A money amount or rate written plainly, zero or more: no sign, no exponent, at most 6 places. */
export const amountSchema = z.string().regex(AMOUNT, 'must be a decimal with at most 6 places, such as 0.85');

/** A positive amount: as `amountSchema`, and above zero. */
export const positiveAmountSchema = amountSchema.refine(
  // Zod runs refinements after a failed regex too, so only parse what the regex accepted.
  (value) => !AMOUNT.test(value) || new Prisma.Decimal(value).greaterThan(0),
  'must be greater than 0',
);

/** A percentage from `min` to `max` inclusive, at most 4 places; negative only when `min` is. */
export function percentSchema(min: number, max: number) {
  return z
    .string()
    .regex(PERCENT, 'must be a percentage with at most 4 places, such as 8')
    .refine((value) => {
      if (!PERCENT.test(value)) return true;
      const percent = new Prisma.Decimal(value);
      return percent.greaterThanOrEqualTo(min) && percent.lessThanOrEqualTo(max);
    }, `must be from ${min} to ${max}`);
}

/** A stable key: lowercase letters, digits and _, starting with a letter. */
export const keySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'lowercase letters, digits and _, starting with a letter');

/** Turns Prisma's unique-violation into a 409; rethrows anything else. */
export function conflictOnDuplicate(error: unknown, message: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictException(message);
  }
  throw error;
}
