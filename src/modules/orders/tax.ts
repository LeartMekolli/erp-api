import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/** A tax rate as the calculation reads it; `country` null is the workspace's default. */
export interface Rate {
  country: string | null;
  region: string | null;
  percent: Prisma.Decimal;
}

/** What an order's tax is worked out from (Orders spec, goal 10 and B2). */
export interface TaxInput {
  /** Not used by the rate table; there for exemptions an outside service may add. */
  customerId: string;
  address: { country: string; region: string | null };
  /** The lines' total, before tax. */
  lines: Prisma.Decimal;
  /** The shipping price, taxed at the order's rate. */
  shipping: Prisma.Decimal;
}

/** Works out an order's tax. The rate table is the default; an outside tax service can replace it. */
export interface TaxCalculator {
  calculate(tx: Tx, input: TaxInput): Promise<{ percent: Prisma.Decimal; amount: Prisma.Decimal }>;
}

export const TAX_CALCULATOR = Symbol('TAX_CALCULATOR');

/** The most specific rate for the address: its region's, else its country's, else the default, else 0. */
export function pickRate(rates: Rate[], address: { country: string; region: string | null }): Prisma.Decimal {
  const match =
    (address.region !== null && rates.find((rate) => rate.country === address.country && rate.region === address.region)) ||
    rates.find((rate) => rate.country === address.country && rate.region === null) ||
    rates.find((rate) => rate.country === null);
  return match ? match.percent : new Prisma.Decimal(0);
}

/** Tax on the lines and the shipping together, rounded half-up to cents once (ADR 0002). */
export function taxAmount(percent: Prisma.Decimal, lines: Prisma.Decimal, shipping: Prisma.Decimal): Prisma.Decimal {
  return lines.plus(shipping).times(percent).dividedBy(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** The workspace's own tax rates (Orders spec, goal 10). */
@Injectable()
export class RateTableTaxCalculator implements TaxCalculator {
  async calculate(tx: Tx, input: TaxInput): Promise<{ percent: Prisma.Decimal; amount: Prisma.Decimal }> {
    const rates = await tx.taxRate.findMany({ select: { country: true, region: true, percent: true } });
    const percent = pickRate(rates, input.address);
    return { percent, amount: taxAmount(percent, input.lines, input.shipping) };
  }
}
