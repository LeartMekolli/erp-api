import { Prisma } from '../../generated/prisma/client';
import { resolveMaterialPrice } from './material-price';
import type { MaterialPriceFields } from './material-price';
import { SEEDED_UNITS } from './units';

const dec = (value: string) => new Prisma.Decimal(value);
const unit = (key: string) => SEEDED_UNITS.find((candidate) => candidate.key === key)!;
const NOW = new Date('2026-10-22T12:00:00Z');

function resolve(options: {
  source?: 'feed' | 'manual';
  currency?: string;
  manual?: string;
  fallback?: string;
  override?: string;
  addonPercent?: string;
  addonAmount?: string;
  feed?: string;
  feedCurrency?: string;
  fetchedHoursAgo?: number;
  pricedUnit?: string;
}) {
  const material: MaterialPriceFields = {
    priceSource: options.source ?? (options.feed !== undefined || options.fallback !== undefined ? 'feed' : 'manual'),
    currency: options.currency ?? 'EUR',
    manualPrice: options.manual === undefined ? null : dec(options.manual),
    fallbackPrice: options.fallback === undefined ? null : dec(options.fallback),
    overridePrice: options.override === undefined ? null : dec(options.override),
    overrideAt: options.override === undefined ? null : new Date('2026-10-21T09:00:00Z'),
    addonPercent: dec(options.addonPercent ?? '0'),
    addonAmount: dec(options.addonAmount ?? '0'),
  };
  const snapshot =
    options.feed === undefined
      ? null
      : {
          pricePerGram: dec(options.feed),
          currency: options.feedCurrency ?? 'EUR',
          fetchedAt: new Date(NOW.getTime() - (options.fetchedHoursAgo ?? 1) * 3_600_000),
        };
  return resolveMaterialPrice({
    material,
    pricedUnit: unit(options.pricedUnit ?? 'g'),
    tenantCurrency: 'EUR',
    snapshot,
    now: NOW,
    staleHours: 48,
  });
}

describe('resolveMaterialPrice', () => {
  it('uses the override first', () => {
    expect(resolve({ manual: '5', override: '0.9' })).toEqual({
      unitPrice: dec('0.9'),
      currency: 'EUR',
      perUnit: 'g',
      source: 'override',
      asOf: new Date('2026-10-21T09:00:00Z'),
      stale: false,
    });
    expect(resolve({ feed: '0.80', fallback: '0.85', override: '0.95' })).toMatchObject({ source: 'override' });
  });

  it('uses the manual price for a manual material', () => {
    expect(resolve({ manual: '0.012' })).toMatchObject({ unitPrice: dec('0.012'), source: 'manual', asOf: null });
  });

  it('applies the add-on to a feed snapshot', () => {
    // 0.80 EUR/g × 1.08 + 0.20 = 1.064
    const price = resolve({ feed: '0.80', fallback: '0.85', addonPercent: '8', addonAmount: '0.20' });
    expect(price).toMatchObject({ source: 'feed', stale: false });
    expect('unitPrice' in price && price.unitPrice.toFixed(6)).toBe('1.064000');
  });

  it('converts the per-gram snapshot to the priced unit before the add-on', () => {
    // 0.80 EUR/g → 800 EUR/kg, + 1 % → 808
    const price = resolve({ feed: '0.80', fallback: '850', addonPercent: '1', pricedUnit: 'kg' });
    expect('unitPrice' in price && price.unitPrice.toFixed(6)).toBe('808.000000');
    expect(price).toMatchObject({ perUnit: 'kg' });
  });

  it('rounds to six decimals', () => {
    const price = resolve({ feed: '0.123456789', fallback: '1' });
    expect('unitPrice' in price && price.unitPrice.toFixed()).toBe('0.123457');
  });

  it('marks a snapshot older than the threshold stale but still uses it', () => {
    expect(resolve({ feed: '0.80', fallback: '0.85', fetchedHoursAgo: 49 })).toMatchObject({ source: 'feed', stale: true });
    expect(resolve({ feed: '0.80', fallback: '0.85', fetchedHoursAgo: 47 })).toMatchObject({ stale: false });
  });

  it('falls back when there is no snapshot', () => {
    expect(resolve({ source: 'feed', fallback: '0.85', addonPercent: '8' })).toMatchObject({
      unitPrice: dec('0.85'),
      source: 'fallback',
      asOf: null,
    });
  });

  it('falls back when the snapshot is in another currency', () => {
    expect(resolve({ feed: '0.80', feedCurrency: 'USD', fallback: '0.85' })).toMatchObject({ source: 'fallback' });
  });

  it('treats a price in another currency as missing', () => {
    expect(resolve({ manual: '5', currency: 'USD' })).toEqual({
      missing: 'Material price is in USD, the workspace uses EUR',
    });
    // The add-on amount and fallback are in the material's currency too, so a feed price cannot rescue it.
    expect(resolve({ feed: '0.80', fallback: '0.85', currency: 'USD' })).toEqual({
      missing: 'Material price is in USD, the workspace uses EUR',
    });
  });
});
