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

/** What a call cost in USD, unrounded. */
export function costOf(model: string, usage: AiResponse['usage']): Prisma.Decimal {
  const prices = aiModel(model);
  return new Prisma.Decimal(usage.inputTokens)
    .mul(prices.inputUsdPerMillion)
    .add(new Prisma.Decimal(usage.outputTokens).mul(prices.outputUsdPerMillion))
    .div(1_000_000);
}
