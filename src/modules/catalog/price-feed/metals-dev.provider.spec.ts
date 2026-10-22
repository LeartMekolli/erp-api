import { MetalsDevProvider } from './metals-dev.provider';

// Shape copied from the "latest" example at https://metals.dev/docs (trimmed).
const LATEST = {
  status: 'success',
  currency: 'EUR',
  unit: 'toz',
  metals: { gold: 1923.86, silver: 22.905, copper: 0.2584, platinum: null, zinc: 'n/a' },
  currencies: { EUR: 0.92 },
  timestamps: { metal: '2026-10-22T05:00:02.829Z', currency: '2026-10-22T05:00:04.204Z' },
};

function stubFetch(status: number, body: unknown) {
  const calls: string[] = [];
  const fetchFn = (url: string | URL | Request) => {
    calls.push(url instanceof Request ? url.url : url.toString());
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  };
  return { calls, fetchFn: fetchFn as typeof fetch };
}

describe('MetalsDevProvider', () => {
  it('asks for troy ounces in the requested currency and converts them to per gram', async () => {
    const { calls, fetchFn } = stubFetch(200, LATEST);
    const prices = await new MetalsDevProvider('secret-key', fetchFn).latest('EUR');

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.metals.dev/v1/latest');
    expect(Object.fromEntries(url.searchParams)).toEqual({ api_key: 'secret-key', currency: 'EUR', unit: 'toz' });

    // value ÷ 31.1034768, to 9 decimals
    expect(Object.fromEntries(prices.map((price) => [price.metal, price.pricePerGram.toFixed(9)]))).toEqual({
      gold: '61.853535294',
      silver: '0.736412850',
      copper: '0.008307753',
    });
  });

  it('skips a metal with a missing or non-numeric price', async () => {
    const { fetchFn } = stubFetch(200, LATEST);
    const metals = (await new MetalsDevProvider('k', fetchFn).latest('EUR')).map((price) => price.metal);
    expect(metals).not.toContain('platinum');
    expect(metals).not.toContain('zinc');
  });

  it('skips a price the snapshot cannot hold, keeping the other metals', async () => {
    const { fetchFn } = stubFetch(200, { ...LATEST, metals: { silver: 22.905, gold: 1e12, copper: 1e-12 } });
    const metals = (await new MetalsDevProvider('k', fetchFn).latest('EUR')).map((price) => price.metal);
    expect(metals).toEqual(['silver']);
  });

  it('throws on an error status without leaking the key', async () => {
    const { fetchFn } = stubFetch(401, {
      status: 'failure',
      error_code: 1101,
      error_message: 'Unauthorized. The API Key provided is invalid.',
    });
    const failing = new MetalsDevProvider('secret-key', fetchFn).latest('EUR');

    await expect(failing).rejects.toThrow(/metals\.dev answered 401/);
    await expect(failing).rejects.not.toThrow(/secret-key/);
  });

  it('throws when the body says failure, or answers in another currency or unit', async () => {
    for (const body of [
      { status: 'failure', error_code: 1203, error_message: 'Quota exceeded' },
      { ...LATEST, currency: 'USD' },
      { ...LATEST, unit: 'g' },
    ]) {
      const { fetchFn } = stubFetch(200, body);
      await expect(new MetalsDevProvider('k', fetchFn).latest('EUR')).rejects.toThrow(/metals\.dev/);
    }
  });
});
