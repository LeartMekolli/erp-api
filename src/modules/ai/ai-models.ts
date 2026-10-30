import { Prisma } from '../../generated/prisma/client';
import type { AiResponse } from './ai-provider';

export interface AiModel {
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  /** Accepts `tool_choice: { type: 'tool' }`. The 5.5 models refuse it with a 400. */
  forcedToolChoice: boolean;
}

/** The Claude models a workspace's AI may run on, with Anthropic's list prices in USD (2026-09). */
export const AI_MODELS: Record<string, AiModel> = {
  'claude-haiku-4-5': { inputUsdPerMillion: '1.00', outputUsdPerMillion: '5.00', forcedToolChoice: true },
  'claude-sonnet-5-5': { inputUsdPerMillion: '2.00', outputUsdPerMillion: '10.00', forcedToolChoice: false },
  'claude-opus-5-5': { inputUsdPerMillion: '4.00', outputUsdPerMillion: '20.00', forcedToolChoice: false },
};

export function aiModel(model: string): AiModel {
  if (!Object.hasOwn(AI_MODELS, model)) {
    throw new Error(`Unknown AI model ${model}`);
  }
  return AI_MODELS[model];
}

/** Rounds of tool calls before a run's final tool is forced. */
export const MAX_TOOL_ROUNDS = 6;
/** The most a model writes in one call. */
export const MAX_OUTPUT_TOKENS = 2_000;
/** Input tokens over a run's calls after which its final tool is forced. */
export const RUN_INPUT_BUDGET = 100_000;
/** What the forced last call is assumed to read on top of the budget: tool results are capped at 25 rows. */
export const LAST_CALL_INPUT_TOKENS = 20_000;

/**
 * The most one run can cost on `model`: the input budget plus its last call, and a full answer from every
 * call. Held back from the limit for each run still waiting, so runs queued together can't all pass it.
 */
export function worstRunCost(model: string): Prisma.Decimal {
  return costOf(model, {
    inputTokens: RUN_INPUT_BUDGET + LAST_CALL_INPUT_TOKENS,
    outputTokens: (MAX_TOOL_ROUNDS + 1) * MAX_OUTPUT_TOKENS,
  });
}

/** What a call cost in USD, unrounded. */
export function costOf(model: string, usage: AiResponse['usage']): Prisma.Decimal {
  const prices = aiModel(model);
  return new Prisma.Decimal(usage.inputTokens)
    .mul(prices.inputUsdPerMillion)
    .add(new Prisma.Decimal(usage.outputTokens).mul(prices.outputUsdPerMillion))
    .div(1_000_000);
}
