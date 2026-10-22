import { Prisma } from '../../../generated/prisma/client';
import type { MetalPriceProvider } from './metal-price-provider';

/** Fixed per-gram prices, the same in every currency: for local work and tests. */
const PRICES: Record<string, string> = {
  gold: '60',
  silver: '0.80',
  platinum: '28',
  palladium: '30',
  copper: '0.009',
  zinc: '0.0027',
};

export class FakeMetalPriceProvider implements MetalPriceProvider {
  readonly name = 'fake';

  latest(_currency: string): Promise<{ metal: string; pricePerGram: Prisma.Decimal }[]> {
    return Promise.resolve(
      Object.entries(PRICES).map(([metal, price]) => ({ metal, pricePerGram: new Prisma.Decimal(price) })),
    );
  }
}
