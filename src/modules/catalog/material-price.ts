import { Prisma } from '../../generated/prisma/client';
import { SEEDED_UNITS, convert } from './units';
import type { UnitDef } from './units';

/** Feed prices are stored per gram; a feed material's priced unit is a mass. */
const GRAM = SEEDED_UNITS.find((unit) => unit.key === 'g')!;

/** Prices are shown and used to 6 decimals (Decimal(18,6) columns). */
const PRICE_DECIMALS = 6;

export interface MaterialPriceFields {
  priceSource: 'feed' | 'manual';
  /** The currency of every price stored on the material, add-on amount included. */
  currency: string;
  manualPrice: Prisma.Decimal | null;
  fallbackPrice: Prisma.Decimal | null;
  overridePrice: Prisma.Decimal | null;
  overrideAt: Date | null;
  addonPercent: Prisma.Decimal;
  addonAmount: Prisma.Decimal;
}

export interface FeedSnapshot {
  pricePerGram: Prisma.Decimal;
  currency: string;
  fetchedAt: Date;
}

export interface ResolvedPrice {
  unitPrice: Prisma.Decimal;
  currency: string;
  /** The unit key the price is per. */
  perUnit: string;
  source: 'override' | 'manual' | 'feed' | 'fallback';
  asOf: Date | null;
  stale: boolean;
}

/**
 * A material's current price per its priced unit (spec C5, B6, B7): the
 * override, else the manual price, else the feed snapshot plus the add-on,
 * else the fallback. Prices in another currency than the workspace's are never
 * converted; such a material has no usable price.
 */
export function resolveMaterialPrice(input: {
  material: MaterialPriceFields;
  pricedUnit: UnitDef;
  tenantCurrency: string;
  snapshot: FeedSnapshot | null;
  now: Date;
  staleHours: number;
}): ResolvedPrice | { missing: string } {
  const { material, pricedUnit, tenantCurrency, snapshot } = input;
  if (material.currency !== tenantCurrency) {
    return { missing: `Material price is in ${material.currency}, the workspace uses ${tenantCurrency}` };
  }

  const price = (unitPrice: Prisma.Decimal, source: ResolvedPrice['source'], asOf: Date | null, stale = false) => ({
    unitPrice: unitPrice.toDecimalPlaces(PRICE_DECIMALS),
    currency: tenantCurrency,
    perUnit: pricedUnit.key,
    source,
    asOf,
    stale,
  });

  if (material.overridePrice) {
    return price(material.overridePrice, 'override', material.overrideAt);
  }
  if (material.priceSource === 'manual') {
    return material.manualPrice
      ? price(material.manualPrice, 'manual', null)
      : { missing: 'Material has no manual price' };
  }
  if (snapshot && snapshot.currency === tenantCurrency) {
    // A price per gram, times grams per priced unit, is the price per priced unit.
    const perUnit = snapshot.pricePerGram.times(convert(new Prisma.Decimal(1), pricedUnit, GRAM));
    const withAddon = perUnit.times(material.addonPercent.dividedBy(100).plus(1)).plus(material.addonAmount);
    const ageHours = (input.now.getTime() - snapshot.fetchedAt.getTime()) / 3_600_000;
    return price(withAddon, 'feed', snapshot.fetchedAt, ageHours > input.staleHours);
  }
  return material.fallbackPrice
    ? price(material.fallbackPrice, 'fallback', null)
    : { missing: 'Material has no feed price and no fallback price' };
}
