import type { Prisma } from '../../../generated/prisma/client';

/** Where daily metal prices come from (Catalog spec C5, C6). The provider is configuration. */
export interface MetalPriceProvider {
  readonly name: string;
  /** Every metal the provider prices, per gram, in `currency`. */
  latest(currency: string): Promise<{ metal: string; pricePerGram: Prisma.Decimal }[]>;
}

/** DI token, so tests and local work use the fake. */
export const METAL_PRICE_PROVIDER = Symbol('METAL_PRICE_PROVIDER');

/** Exact: one troy ounce in grams. */
export const GRAMS_PER_TROY_OUNCE = '31.1034768';
