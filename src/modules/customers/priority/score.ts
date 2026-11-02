import type { Prisma } from '../../../generated/prisma/client';

/**
 * A customer's priority score (Customers 2 spec, goals 11–13): four parts of its history, each a percentile
 * rank among the workspace's customers that ordered in the last 365 days, mixed by the workspace's weights.
 */

/** What the parts are worked out from. Spend is net of tax and completed refunds, in the workspace's currency. */
export interface History {
  customerId: string;
  lifetime: Prisma.Decimal;
  /** Spend on orders placed in the last 90 days. */
  recent: Prisma.Decimal;
  /** Orders placed in the last 365 days; a customer without one isn't compared. */
  orders365: number;
  /** Invoices of the last 365 days that are paid or past their due date. */
  invoicesDue: number;
  /** Of those, the ones paid by their due date. */
  invoicesOnTime: number;
}

/** Each 0–100. */
export interface Parts {
  lifetime: number;
  recent: number;
  frequency: number;
  payment: number;
}

export type Weights = Parts;

export const NO_PARTS: Parts = { lifetime: 0, recent: 0, frequency: 0, payment: 0 };

/**
 * Each value's percentile rank, 0–100: ties share their average place, the highest gets 100, and a value
 * alone gets 100.
 */
function ranks(values: number[]): number[] {
  if (values.length === 1) return [100];
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end += 1;
    const place = (start + end) / 2;
    for (let at = start; at <= end; at += 1) result[order[at].index] = Math.round((place / (values.length - 1)) * 100);
    start = end + 1;
  }
  return result;
}

/** The parts of every customer with an order in the last 365 days; the others are left out. */
export function percentileParts(histories: History[]): Map<string, Parts> {
  const compared = histories.filter((history) => history.orders365 >= 1);
  if (compared.length === 0) return new Map();
  // Spend is compared to the cent, which a number holds exactly at any realistic size.
  const lifetime = ranks(compared.map((history) => history.lifetime.toNumber()));
  const recent = ranks(compared.map((history) => history.recent.toNumber()));
  const frequency = ranks(compared.map((history) => history.orders365));
  // No invoice due yet counts as always on time.
  const payment = ranks(compared.map((history) => (history.invoicesDue === 0 ? 1 : history.invoicesOnTime / history.invoicesDue)));
  return new Map(
    compared.map((history, index) => [
      history.customerId,
      { lifetime: lifetime[index], recent: recent[index], frequency: frequency[index], payment: payment[index] },
    ]),
  );
}

/** The weighted mean of the parts, rounded; 0 when every weight is 0. */
export function scoreOf(parts: Parts, weights: Weights): number {
  const keys = Object.keys(weights) as (keyof Weights)[];
  const total = keys.reduce((sum, key) => sum + weights[key], 0);
  if (total === 0) return 0;
  return Math.round(keys.reduce((sum, key) => sum + weights[key] * parts[key], 0) / total);
}

/** The band with the highest start at or below the score; null for the default band. */
export function bandFor(score: number, bands: { key: string; from: number }[]): string | null {
  let best: { key: string; from: number } | null = null;
  for (const band of bands) {
    if (band.from <= score && (best === null || band.from > best.from)) best = band;
  }
  return best?.key ?? null;
}
