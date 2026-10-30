import { IMAGE_MODELS, MAX_WEB_SEARCHES, WEB_SEARCH_USD, extraWorstCost, imageCost } from './extra-costs';

describe('extra costs', () => {
  it('prices one image at the table price of its model', () => {
    expect(imageCost('gpt-image-2.5-flare').toString()).toBe(IMAGE_MODELS['gpt-image-2.5-flare'].usdPerImage);
  });

  it('throws for a model not in the table', () => {
    expect(() => imageCost('some-other-model')).toThrow('Unknown image model some-other-model');
  });

  it('prices web search at 10 USD per 1,000 searches, at most 5 a run', () => {
    expect(WEB_SEARCH_USD).toBe('0.01');
    expect(MAX_WEB_SEARCHES).toBe(5);
  });

  it('holds back one image for an image run, and every search for a recommendations run', () => {
    expect(extraWorstCost('image', 'gpt-image-2.5-flare').toString()).toBe(imageCost('gpt-image-2.5-flare').toString());
    expect(extraWorstCost('recommendations', 'gpt-image-2.5-flare').toFixed(2)).toBe('0.05');
  });

  it('holds back nothing beyond tokens for the other kinds', () => {
    for (const kind of ['ask', 'briefing', 'marketing', 'brand_content'] as const) {
      expect(extraWorstCost(kind, 'gpt-image-2.5-flare').isZero()).toBe(true);
    }
  });
});
