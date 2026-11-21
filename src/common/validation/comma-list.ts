import { z } from 'zod';

/** A comma-separated list of `values`, at least one, each named once; anything else is a 400. */
export const commaList = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((raw) => raw.split(','))
    .pipe(z.array(z.enum(values)).min(1))
    .transform((list) => [...new Set(list)]);
