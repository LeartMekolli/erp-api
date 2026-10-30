import type { AiRun } from '../../../generated/prisma/client';
import type { PlanFeature } from '../../payments/plans/plans';

/** The AI tools customers use from the portal, paid in credits (AI 2 spec). Each is a run kind. */
export const CUSTOMER_TOOLS = ['recommendations', 'marketing', 'brand_content', 'image'] as const;
export type CustomerTool = (typeof CUSTOMER_TOOLS)[number];

/** The plan switch each tool needs. */
export const TOOL_FEATURE: Record<CustomerTool, PlanFeature> = {
  recommendations: 'ai_recommendations',
  marketing: 'ai_marketing',
  brand_content: 'ai_brand',
  image: 'ai_images',
};

/** Credits per use while the workspace has no `ai.toolPrices`; a refinement costs an image. */
export const DEFAULT_TOOL_PRICES: Record<CustomerTool, number> = { recommendations: 10, marketing: 5, brand_content: 3, image: 5 };

/** What a customer sees of a failed run; the internal error stays in the run log. */
export const CUSTOMER_FAILED_MESSAGE = 'The AI could not finish this. Your credits were given back.';

/** What a tool's handler gets: the run, and the customer it is for, from `ai_customer_result`. */
export interface CustomerRun {
  tenantId: string;
  run: AiRun;
  customerId: string;
  userId: string;
  parentId: string | null;
}
