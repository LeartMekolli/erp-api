import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { parseOpaqueToken } from '../identity/opaque-token';

/** What an invitation link is, for the page that accepts it: never the token's tenant id or anything about other people. */
export const invitationPreviewResponseSchema = z.strictObject({
  /** Which accept route to call: `/auth/invitations/accept`, `/auth/partner-invitations/accept` or `/auth/customer-invitations/accept`. */
  kind: z.enum(['staff', 'partner', 'customer']),
  /** Only a pending invitation can be accepted. */
  status: z.enum(['pending', 'accepted', 'expired']),
  email: z.string(),
  /** The workspace role's name for staff; the partner or customer role otherwise. */
  role: z.string(),
  workspace: z.strictObject({ name: z.string() }),
  /** The partner or customer the invitee will act for; null for staff. */
  organisation: z.strictObject({ name: z.string() }).nullable(),
  /**
   * Someone with this email already has an account in the workspace. For a partner or customer invitation,
   * accepting then takes only the token; a staff invitation to an existing account is refused on accepting.
   */
  has_account: z.boolean(),
});
export type InvitationPreviewResponse = z.infer<typeof invitationPreviewResponseSchema>;

type Found = Pick<InvitationPreviewResponse, 'kind' | 'role' | 'organisation'> & {
  email: string;
  acceptedAt: Date | null;
  expiresAt: Date;
};

/**
 * One accept link serves three kinds of invitation; this tells the page which one a token is. The
 * token is the only key: an unknown one, or one of a suspended workspace, is not found, so the route
 * says nothing to someone without a real link.
 */
@Injectable()
export class InvitationPreviewService {
  constructor(private readonly prisma: PrismaService) {}

  async preview(token: string): Promise<InvitationPreviewResponse> {
    const parsed = parseOpaqueToken(token);
    if (!parsed) {
      throw notFound();
    }

    return this.prisma.inTenant(parsed.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: parsed.tenantId }, select: { name: true, status: true } });
      if (!tenant || tenant.status !== 'active') {
        throw notFound();
      }
      const found = await this.find(tx, parsed.hash);
      if (!found) {
        throw notFound();
      }
      const account = await tx.user.findFirst({ where: { email: found.email }, select: { id: true } });
      const status = found.acceptedAt ? 'accepted' : found.expiresAt <= new Date() ? 'expired' : 'pending';
      return {
        kind: found.kind,
        status,
        email: found.email,
        role: found.role,
        workspace: { name: tenant.name },
        organisation: found.organisation,
        has_account: account !== null,
      };
    });
  }

  /** The token hash is unique within each table; a token is only ever in one of them. */
  private async find(tx: Prisma.TransactionClient, tokenHash: string): Promise<Found | null> {
    const staff = await tx.invitation.findUnique({ where: { tokenHash }, include: { role: { select: { name: true } } } });
    if (staff) {
      return { ...staff, kind: 'staff', role: staff.role.name, organisation: null };
    }
    const partner = await tx.partnerInvitation.findUnique({ where: { tokenHash }, include: { partner: { select: { displayName: true } } } });
    if (partner) {
      // The name the invitation email used.
      return { ...partner, kind: 'partner', organisation: { name: partner.partner.displayName } };
    }
    const customer = await tx.customerInvitation.findUnique({ where: { tokenHash }, include: { customer: { select: { name: true } } } });
    if (customer) {
      return { ...customer, kind: 'customer', organisation: { name: customer.customer.name } };
    }
    return null;
  }
}

function notFound(): NotFoundException {
  return new NotFoundException('Invitation not found');
}
