import { Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { GRAMS_PER_TROY_OUNCE } from './metal-price-provider';
import type { MetalPriceProvider } from './metal-price-provider';

const LATEST_URL = 'https://api.metals.dev/v1/latest';
const PER_GRAM_DECIMALS = 9;

interface LatestBody {
  status?: string;
  currency?: string;
  unit?: string;
  metals?: Record<string, unknown>;
}

/**
 * Metals.Dev's "latest" endpoint (https://metals.dev/docs), asked for troy
 * ounces so precious and base metals share one unit, then converted exactly to
 * grams. The API key travels in the query string, so neither the URL nor the
 * key ever reaches a log line or an error message.
 */
export class MetalsDevProvider implements MetalPriceProvider {
  readonly name = 'metalsdev';
  private readonly logger = new Logger(MetalsDevProvider.name);

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async latest(currency: string): Promise<{ metal: string; pricePerGram: Prisma.Decimal }[]> {
    const url = new URL(LATEST_URL);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('currency', currency);
    url.searchParams.set('unit', 'toz');

    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      throw new Error(`metals.dev answered ${response.status} for ${currency}`);
    }
    const body = (await response.json()) as LatestBody;
    if (body.status !== 'success') {
      throw new Error(`metals.dev reported ${String(body.status)} for ${currency}`);
    }
    if (body.currency !== currency || body.unit !== 'toz') {
      throw new Error(`metals.dev answered in ${String(body.currency)} per ${String(body.unit)}, not ${currency} per toz`);
    }

    const prices: { metal: string; pricePerGram: Prisma.Decimal }[] = [];
    for (const [metal, value] of Object.entries(body.metals ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        this.logger.warn(`metals.dev gave no usable ${currency} price for ${metal}; skipped`);
        continue;
      }
      prices.push({
        metal,
        pricePerGram: new Prisma.Decimal(String(value)).dividedBy(GRAMS_PER_TROY_OUNCE).toDecimalPlaces(PER_GRAM_DECIMALS),
      });
    }
    return prices;
  }
}
