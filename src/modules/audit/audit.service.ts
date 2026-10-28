import { Injectable } from '@nestjs/common';
import { currentRequestId } from '../../common/request-context/request-context';
import type { Prisma } from '../../generated/prisma/client';

/** The sensitive actions of F8. */
export type AuditAction =
  | 'tenant.created'
  | 'tenant.suspended'
  | 'role.created'
  | 'role.permissions_changed'
  | 'role.deleted'
  | 'user.roles_changed'
  | 'user.deactivated'
  | 'auth.refresh_chain_revoked'
  | 'template.override_changed'
  | 'material.price_overridden'
  | 'material.price_override_removed'
  | 'pricing.changed'
  | 'customer.changed'
  | 'customer.member_changed'
  | 'workspace.customer_site_changed'
  | 'workflow.changed'
  | 'partner.changed'
  | 'partner.member_changed'
  | 'partner.job'
  | 'order.changed'
  | 'payment.account.changed'
  | 'customer.payment_terms.changed'
  | 'order.paid_by_hand';

export interface AuditInput {
  actor: { type: 'user' | 'platform_admin' | 'system'; id?: string };
  action: AuditAction;
  subject: { type: string; id?: string };
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
}

/**
 * Writes into the caller's transaction, so an entry exists exactly when the
 * change it describes was committed (spec 4.9). Insert only: the table refuses
 * updates and deletes (ADR 0003), and nothing here offers them.
 */
@Injectable()
export class AuditService {
  async record(tx: Prisma.TransactionClient, entry: AuditInput): Promise<void> {
    await tx.auditEntry.create({
      data: {
        actorType: entry.actor.type,
        actorId: entry.actor.id,
        action: entry.action,
        subjectType: entry.subject.type,
        subjectId: entry.subject.id,
        before: entry.before,
        after: entry.after,
        requestId: currentRequestId(),
      },
    });
  }
}
