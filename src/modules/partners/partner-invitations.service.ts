import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { GoogleIdentityService } from '../auth/google-identity.service';
import type { AcceptCredentials } from '../customers/customer-invitations.service';
import { emailSchema } from '../identity/email';
import { IDENTITY_NOTIFIER } from '../identity/identity-notifier';
import type { IdentityNotifier } from '../identity/identity-notifier';
import { INVITATION_DAYS } from '../identity/invitations';
import { issueOpaqueToken, parseOpaqueToken } from '../identity/opaque-token';
import { hashPassword } from '../identity/passwords';
import type { PartnerInvitationResponse } from './partner-response';
import { PARTNER_ROLES } from './partner-roles';
import type { PartnerRole } from './partner-roles';
import { lockPartner } from './partners.service';

export const invitePartnerPersonSchema = z.object({ email: emailSchema, role: z.enum(PARTNER_ROLES) });

function invalidInvitation(): BadRequestException {
  return new BadRequestException('Invitation is invalid or expired');
}

function otherKindEmail(): ConflictException {
  return new ConflictException('This email belongs to a staff user or a customer person');
}

/** Whether the partner already has an owner; call with the partner row locked. */
async function hasOwner(tx: Prisma.TransactionClient, partnerId: string): Promise<boolean> {
  const owner = await tx.organisationMembership.findFirst({
    where: { organisationType: 'partner', organisationId: partnerId, role: 'owner' },
    select: { id: true },
  });
  return owner !== null;
}

async function isMember(tx: Prisma.TransactionClient, userId: string, partnerId: string): Promise<boolean> {
  const membership = await tx.organisationMembership.findFirst({
    where: { userId, organisationType: 'partner', organisationId: partnerId },
    select: { id: true },
  });
  return membership !== null;
}

/** Inviting people to act for a partner, and accepting (Partners spec, goal 1). Mirrors customer invitations. */
@Injectable()
export class PartnerInvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleIdentityService,
    @Inject(IDENTITY_NOTIFIER) private readonly notifier: IdentityNotifier,
  ) {}

  /**
   * Refuses an email that belongs to staff or a customer person (a user is
   * one kind, never two), someone already acting for the partner, and a second
   * owner. Earlier pending invitations for the same email and partner are
   * expired, so only the newest link works. The token goes to the notifier,
   * after commit, never into the response.
   */
  async invite(
    tenantId: string,
    partnerId: string,
    input: { email: string; role: PartnerRole; invitedByUserId: string },
  ): Promise<PartnerInvitationResponse> {
    const created = await this.prisma.inTenant(tenantId, async (tx) => {
      await lockPartner(tx, partnerId);
      const partner = await tx.partner.findUniqueOrThrow({ where: { id: partnerId }, select: { displayName: true } });

      const existing = await tx.user.findFirst({ where: { email: input.email }, select: { id: true, kind: true } });
      if (existing && existing.kind !== 'partner') {
        throw otherKindEmail();
      }
      if (existing && (await isMember(tx, existing.id, partnerId))) {
        throw new ConflictException('This person already acts for the partner');
      }
      if (input.role === 'owner' && (await hasOwner(tx, partnerId))) {
        throw new ConflictException('The partner already has an owner');
      }

      const now = new Date();
      await tx.partnerInvitation.updateMany({
        where: { partnerId, email: input.email, acceptedAt: null, expiresAt: { gt: now } },
        data: { expiresAt: now },
      });

      const { token, hash } = issueOpaqueToken(tenantId);
      const invitation = await tx.partnerInvitation.create({
        data: {
          partnerId,
          email: input.email,
          role: input.role,
          tokenHash: hash,
          invitedByUserId: input.invitedByUserId,
          expiresAt: new Date(now.getTime() + INVITATION_DAYS * 24 * 60 * 60 * 1000),
        },
      });
      return { invitation, token, partnerName: partner.displayName };
    });

    await this.notifier.partnerInvitationCreated({
      tenantId,
      invitationId: created.invitation.id,
      email: input.email,
      partnerName: created.partnerName,
      token: created.token,
    });

    return {
      id: created.invitation.id,
      email: created.invitation.email,
      role: input.role,
      expires_at: created.invitation.expiresAt.toISOString(),
    };
  }

  /**
   * As customer acceptance: a new email creates a partner person, with a name
   * and a password or a Google account with the invitation's verified email;
   * an existing partner person only gains the membership. Unknown, expired,
   * already accepted and other-tenant tokens are all the same 400. The claim
   * is a conditional update and the one-owner rule is checked again under the
   * partner row lock, so concurrent acceptances cannot break either.
   */
  async accept(token: string, credentials: AcceptCredentials): Promise<void> {
    const parsed = parseOpaqueToken(token);
    if (!parsed) {
      throw invalidInvitation();
    }

    // Outside the transaction: verifying may fetch Google's keys, and argon2 should not hold it open.
    const google =
      credentials.googleIdToken === undefined
        ? undefined
        : await this.google.identity(parsed.tenantId, credentials.googleIdToken);
    const name = credentials.name ?? google?.name ?? undefined;
    const password = credentials.password ?? (google ? randomBytes(32).toString('base64url') : undefined);
    const passwordHash = password === undefined ? undefined : await hashPassword(password);

    try {
      await this.prisma.inTenant(parsed.tenantId, async (tx) => {
        const now = new Date();
        const invitation = await tx.partnerInvitation.findUnique({ where: { tokenHash: parsed.hash } });
        if (!invitation || invitation.acceptedAt || invitation.expiresAt <= now) {
          throw invalidInvitation();
        }

        const tenant = await tx.tenant.findUnique({
          where: { id: parsed.tenantId },
          select: { status: true, defaultLocale: true },
        });
        if (!tenant || tenant.status !== 'active') {
          throw invalidInvitation();
        }

        const claimed = await tx.partnerInvitation.updateMany({
          where: { id: invitation.id, acceptedAt: null },
          data: { acceptedAt: now },
        });
        if (claimed.count === 0) {
          throw invalidInvitation();
        }
        if (google && (!google.emailVerified || google.email !== invitation.email)) {
          throw new BadRequestException("The Google account's verified email must be the invitation's email");
        }

        await lockPartner(tx, invitation.partnerId);
        if (invitation.role === 'owner' && (await hasOwner(tx, invitation.partnerId))) {
          throw new ConflictException('The partner already has an owner');
        }

        let user = await tx.user.findFirst({ where: { email: invitation.email }, select: { id: true, kind: true } });
        if (user && user.kind !== 'partner') {
          throw otherKindEmail();
        }
        if (user && (await isMember(tx, user.id, invitation.partnerId))) {
          throw new ConflictException('This person already acts for the partner');
        }
        if (!user) {
          if (!name || !passwordHash) {
            throw new BadRequestException('A name and a password or Google account are needed to create your account');
          }
          user = await tx.user.create({
            data: { email: invitation.email, passwordHash, name, locale: tenant.defaultLocale, kind: 'partner' },
            select: { id: true, kind: true },
          });
        }

        await tx.organisationMembership.create({
          data: {
            userId: user.id,
            organisationType: 'partner',
            organisationId: invitation.partnerId,
            role: invitation.role,
          },
        });

        if (google) {
          const linked = await tx.externalIdentity.findUnique({
            where: { tenantId_provider_subject: { tenantId: parsed.tenantId, provider: 'google', subject: google.subject } },
            select: { userId: true },
          });
          if (linked && linked.userId !== user.id) {
            throw new ConflictException('This Google account already signs in as someone else');
          }
          if (!linked) {
            await tx.externalIdentity.create({ data: { provider: 'google', subject: google.subject, userId: user.id } });
          }
        }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Someone else used this email at the same time; try again');
      }
      throw error;
    }
  }
}
