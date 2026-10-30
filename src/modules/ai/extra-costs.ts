import { Prisma } from '../../generated/prisma/client';
import type { RunKind } from './runs.service';

/**
 * The image models customers' images may be made with, and what one image costs in USD (AI 2 spec, goal
 * 17). OpenAI bills image tokens: $30 per million output tokens for both (2026-10), about 0.05 USD for one
 * 1024×1024 medium image; 0.07 also covers the input image of an edit.
 */
export const IMAGE_MODELS: Record<string, { usdPerImage: string }> = {
  'gpt-image-2.5-flare': { usdPerImage: '0.07' },
  'gpt-image-2.5-sunburst': { usdPerImage: '0.07' },
};

export function imageCost(model: string): Prisma.Decimal {
  if (!Object.hasOwn(IMAGE_MODELS, model)) {
    throw new Error(`Unknown image model ${model}`);
  }
  return new Prisma.Decimal(IMAGE_MODELS[model].usdPerImage);
}

/** What one of Claude's web searches costs: 10 USD per 1,000 searches. */
export const WEB_SEARCH_USD = '0.01';

/** The most web searches one run may make. */
export const MAX_WEB_SEARCHES = 5;

/**
 * The most a run of `kind` can cost beyond its tokens: an image run makes one image on `imageModel`, a
 * recommendations run every search it may. Held back from the limit with the tokens' worst case.
 */
export function extraWorstCost(kind: RunKind, imageModel: string): Prisma.Decimal {
  if (kind === 'image') return imageCost(imageModel);
  if (kind === 'recommendations') return new Prisma.Decimal(WEB_SEARCH_USD).mul(MAX_WEB_SEARCHES);
  return new Prisma.Decimal(0);
}
