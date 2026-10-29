import { Prisma } from '../../generated/prisma/client';

/** The UTC calendar month holding `at`, as Anthropic bills: `[start, end)` and its `YYYY-MM` key. */
export function monthBounds(at: Date): { start: Date; end: Date; key: string } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end, key: start.toISOString().slice(0, 7) };
}

/** The notice the month's spend has reached: 100 at the limit or past it, 80 from 80 %. */
export function noticeLevel(spent: Prisma.Decimal, limit: Prisma.Decimal): 80 | 100 | null {
  if (spent.gte(limit)) return 100;
  if (spent.gte(limit.mul('0.8'))) return 80;
  return null;
}
