import { uuidv7 } from 'uuidv7';

/**
 * Every identifier in the system (ADR 0004).
 *
 * Version 7 puts a millisecond timestamp in the leading bits, so ids sort
 * chronologically as plain strings and insert near the end of a B-tree index
 * instead of scattering across it. Generated here rather than by the database,
 * because Postgres 16 has no uuidv7() function.
 */
export function newId(): string {
  return uuidv7();
}
