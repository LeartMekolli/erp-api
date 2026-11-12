import type { JobAssignment, Prisma } from '../../generated/prisma/client';
import type { PartnerAuth } from '../identity/auth-context';
import { toTransition, transitionInclude } from '../workflow/transition-rows';
import type { PartnerActor, PartnerTransitionResponse } from './partner-response';

// How a partner reads the moves on a job it holds (Move history spec): who made each, named only for its
// own people. Shared by the job's moves, the job detail and a piece's history, so they never disagree.

/** A transition with the kind of user who made it, so a partner can tell its own people from the workspace's. */
export const partnerTransitionInclude = {
  ...transitionInclude,
  actor: { select: { id: true, name: true, kind: true } },
} as const satisfies Prisma.TransitionInclude;

/**
 * Who made a move: the partner's own people, when a partner person made it for this partner (a partner's
 * move is always credited to the partner holding the job); another partner's people; or else the workspace.
 * Read from the move, not from who belongs to the partner now: a person of two partners stays with the one
 * they moved for, and a former member's moves stay the partner's own. Only its own people are named.
 */
export function actorOf(
  auth: PartnerAuth,
  row: { actor: { kind: string; name: string }; partnerId: string | null },
): { kind: PartnerActor; name: string | null } {
  if (row.actor.kind !== 'partner') {
    return { kind: 'workspace', name: null };
  }
  return row.partnerId === auth.partnerId ? { kind: 'own', name: row.actor.name } : { kind: 'other_partner', name: null };
}

/** A move of a piece as the partner reads it: what was written only on its own people's moves. */
export function toPartnerTransition(
  auth: PartnerAuth,
  row: Prisma.TransitionGetPayload<{ include: typeof partnerTransitionInclude }>,
): PartnerTransitionResponse {
  const { actor: _actor, partner: _partner, ...move } = toTransition(row);
  const actor = actorOf(auth, row);
  const own = actor.kind === 'own';
  return {
    ...move,
    override_reason: own ? move.override_reason : null,
    comment: own ? move.comment : null,
    answers: move.answers.map((answer) => ({ ...answer, note: own ? answer.note : null })),
    actor,
  };
}

/** When the job came to the partner: it accepted the offer, or else staff handed or moved it over. */
export function handedOverAt(row: JobAssignment): Date {
  return row.respondedAt ?? row.createdAt;
}
