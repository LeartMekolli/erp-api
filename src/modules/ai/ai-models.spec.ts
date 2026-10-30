import {
  AI_MODELS,
  LAST_CALL_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MAX_TOOL_ROUNDS,
  RUN_INPUT_BUDGET,
  costOf,
  worstRunCost,
} from './ai-models';

describe('worstRunCost', () => {
  it('is the input budget and its last call in, and a full answer from every call out', () => {
    expect(worstRunCost('claude-haiku-4-5').toFixed(2)).toBe('0.19');
    expect(worstRunCost('claude-sonnet-5-5').toFixed(2)).toBe('0.38');
    expect(worstRunCost('claude-opus-5-5').toFixed(2)).toBe('0.76');
    expect(worstRunCost('claude-opus-5-5').toFixed(6)).toBe(
      costOf('claude-opus-5-5', {
        inputTokens: RUN_INPUT_BUDGET + LAST_CALL_INPUT_TOKENS,
        outputTokens: (MAX_TOOL_ROUNDS + 1) * MAX_OUTPUT_TOKENS,
      }).toFixed(6),
    );
  });
});

describe('costOf', () => {
  it.each(Object.keys(AI_MODELS))('charges %s its two prices for a million tokens each way', (model) => {
    const prices = AI_MODELS[model];

    const cost = costOf(model, { inputTokens: 1_000_000, outputTokens: 1_000_000 });

    expect(cost.toFixed(6)).toBe(
      (Number(prices.inputUsdPerMillion) + Number(prices.outputUsdPerMillion)).toFixed(6),
    );
  });

  it('prices a small call to the millionth of a dollar', () => {
    // Sonnet 5.5: 2.00 in, 10.00 out per million.
    expect(costOf('claude-sonnet-5-5', { inputTokens: 1234, outputTokens: 567 }).toFixed(6)).toBe('0.008138');
  });

  it('costs nothing for no tokens', () => {
    expect(costOf('claude-sonnet-5-5', { inputTokens: 0, outputTokens: 0 }).isZero()).toBe(true);
  });

  it('throws for a model not in the table', () => {
    expect(() => costOf('some-other-model', { inputTokens: 1, outputTokens: 1 })).toThrow(/some-other-model/);
  });
});
