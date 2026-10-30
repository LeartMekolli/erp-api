import { IMAGE_MODELS, MAX_WEB_SEARCHES, WEB_SEARCH_USD, imageCost } from './extra-costs';

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
});
