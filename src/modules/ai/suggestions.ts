import type { RecordRef } from './tools/tool';

/**
 * What the AI may suggest or propose (AI 1 spec, goal 8): a kind fixed in code and its targets. Each opens
 * a screen, filled in, for a person to confirm; none changes anything itself.
 */
export const SUGGESTION_TARGETS = {
  // A waiting job to a partner with room.
  offer_job: ['job', 'partner'],
  chase_invoice: ['invoice'],
  // A held order.
  release_order: ['order'],
  // A customer ordering less than usual or paying late.
  contact_customer: ['customer'],
  // A late or defect-heavy partner.
  review_partner: ['partner'],
  // A slow or defect-heavy workflow step.
  review_step: ['step'],
} as const satisfies Record<string, readonly RecordRef['type'][]>;

export type SuggestionKind = keyof typeof SUGGESTION_TARGETS;
export const SUGGESTION_KINDS = Object.keys(SUGGESTION_TARGETS) as [SuggestionKind, ...SuggestionKind[]];

/** How long a dismissed suggestion stays away, for everyone in the workspace. */
export const DISMISS_DAYS = 14;

/** The same suggestion, whatever order its targets come in: its kind and its sorted targets. */
export function fingerprint(kind: SuggestionKind, targets: RecordRef[]): string {
  return `${kind}|${targets
    .map((target) => `${target.type}:${target.id}`)
    .sort()
    .join(',')}`;
}

/** Whether `targets` are exactly one record of each type the kind names. */
export function targetsFit(kind: SuggestionKind, targets: RecordRef[]): boolean {
  const wanted: readonly string[] = SUGGESTION_TARGETS[kind];
  return targets.length === wanted.length && wanted.every((type) => targets.filter((target) => target.type === type).length === 1);
}
