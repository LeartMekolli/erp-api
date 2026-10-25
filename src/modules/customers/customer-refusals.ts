import type { QuoteRefusal, QuoteRefusalCode } from '../pricing/quote-response';

const CONTACT_US = "We can't price this configuration yet. Please contact us.";
const NOT_OFFERED = "This option isn't available for this product.";
const NOT_COMBINABLE = "These options can't be combined.";

/**
 * What a customer reads for each refusal (Customers spec): fixed plain text,
 * so nothing about the pricing setup (steps, materials, rules) reaches them.
 * Staff keep the full message. A code without an entry does not compile.
 */
export const CUSTOMER_REFUSAL_MESSAGES: Record<QuoteRefusalCode, string> = {
  unknown_group: NOT_OFFERED,
  unknown_value: NOT_OFFERED,
  value_not_offered: NOT_OFFERED,
  required_missing: 'Choose a value for every required option.',
  rule_excludes: NOT_COMBINABLE,
  rule_requires: NOT_COMBINABLE,
  conflicting_materials: NOT_COMBINABLE,
  no_material: 'Choose a material.',
  size_out_of_range: "This size isn't available.",
  unknown_size: "This size isn't available.",
  not_sizeable: 'This product comes in one size only.',
  file_required: 'Upload your design file.',
  file_not_measured: 'Your file is still being processed.',
  measure_missing: "Your file couldn't be measured.",
  price_missing: CONTACT_US,
  no_steps: CONTACT_US,
  price_too_large: CONTACT_US,
  step_conflict: CONTACT_US,
  step_price_missing: CONTACT_US,
  density_missing: CONTACT_US,
  unit_mismatch: CONTACT_US,
  workflow_missing: CONTACT_US,
  workflow_step_missing: CONTACT_US,
  partner_unavailable: "This workshop can't take this job right now. Please pick another.",
};

/** The refusal as a customer sees it: the code and the plain message, nothing else. */
export function customerRefusal(reason: QuoteRefusal): { code: QuoteRefusalCode; message: string } {
  return { code: reason.code, message: CUSTOMER_REFUSAL_MESSAGES[reason.code] };
}
