import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { GoogleIdentityService } from '../auth/google-identity.service';
import { IDENTITY_NOTIFIER } from '../identity/identity-notifier';
import type { IdentityNotifier } from '../identity/identity-notifier';
import { INVITATION_DAYS } from '../identity/invitations';
import { issueOpaqueToken, parseOpaqueToken } from '../identity/opaque-token';
import { hashPassword } from '../identity/passwords';
import type { CustomerInvitationResponse } from './customer-response';
import type { CustomerRole } from './customer-roles';
import { lockCustomer } from './customers.service';

function invalidInvitation(): BadRequestException {
  return new BadRequestException('Invitation is invalid or expired');
}

function staffEmail(): ConflictException {
  return new ConflictException('This email belongs to a staff user');
}

/** Whether the customer already has an owner; call with the customer row locked. */
async function hasOwner(tx: Prisma.TransactionClient, customerId: string): Promise<boolean> {
  const owner = await tx.organisationMembership.findFirst({
    where: { organisationType: 'customer', organisationId: customerId, role: 'owner' },
    select: { id: true },
  });
  return owner !== null;
}

/** What someone sends to accept: a password, or a Google ID token, or neither if they already have an account. */
export interface AcceptCredentials {
  name?: string;
  password?: string;
  googleIdToken?: string;
}

/** Inviting people to act for a customer, and accepting (Customers spec, goals 2–4). */
@Injectable()
export class CustomerInvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleIdentityService,
    @Inject(IDENTITY_NOTIFIER) private readonly notifier: IdentityNotifier,
  ) {}

  /**
   * Refuses an email that belongs to staff (a user is staff or a customer
   * person, never both), someone already acting for the customer, and a second
   * owner. Earlier pending invitations for the same email and customer are
   * expired, so only the newest link works. The token goes to the notifier,
   * after commit, never into the response (D78).
   */
  async invite(
    tenantId: string,
    customerId: string,
    input: { email: string; role: CustomerRole; invitedByUserId: string | null },
  ): Promise<CustomerInvitationResponse> {
    const created = await this.prisma.inTenant(tenantId, async (tx) => {
      const customer = await lockCustomer(tx, customerId);

      const existing = await tx.user.findFirst({ where: { email: input.email }, select: { id: true, kind: true } });
      if (existing?.kind === 'staff') {
        throw staffEmail();
      }
      if (existing && (await this.isMember(tx, existing.id, customerId))) {
        throw new ConflictException('This person already acts for the customer');
      }
      if (input.role === 'owner' && (await hasOwner(tx, customerId))) {
        throw new ConflictException('The customer already has an owner');
      }

      const now = new Date();
      await tx.customerInvitation.updateMany({
        where: { customerId, email: input.email, acceptedAt: null, expiresAt: { gt: now } },
        data: { expiresAt: now },
      });

      const { token, hash } = issueOpaqueToken(tenantId);
      const invitation = await tx.customerInvitation.create({
        data: {
          customerId,
          email: input.email,
          role: input.role,
          tokenHash: hash,
          invitedByUserId: input.invitedByUserId,
          expiresAt: new Date(now.getTime() + INVITATION_DAYS * 24 * 60 * 60 * 1000),
        },
      });
      return { invitation, token, customerName: customer.name };
    });

    await this.notifier.customerInvitationCreated({
      tenantId,
      invitationId: created.invitation.id,
      email: input.email,
      customerName: created.customerName,
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
   * A new email creates a customer person, which needs a name and either a
   * password or a Google account with the invitation's verified email (whose
   * name is the default, and which is linked for Google sign-in). An existing
   * customer person only gains the membership, with no credentials asked.
   * Unknown, expired, already accepted and other-tenant tokens are all the
   * same 400. The invitation is claimed with a conditional update, and the
   * one-owner rule is checked again under the customer row lock, so
   * concurrent acceptances cannot break either.
   */
  async accept(token: string, credentials: AcceptCredentials): Promise<void> {
    const parsed = parseOpaqueToken(token);
    if (!parsed) {
      throw invalidInvitation();
    }

    // Outside the transaction: verifying may fetch Google's keys.
    const google =
      credentials.googleIdToken === undefined
        ? undefined
        : await this.google.identity(parsed.tenantId, credentials.googleIdToken);
    const name = credentials.name ?? google?.name ?? undefined;

    // Hashed before the transaction, which should not wait on argon2. Someone
    // who joins with Google gets a random password nobody knows; a password
    // reset sets a real one.
    const password = credentials.password ?? (google ? randomBytes(32).toString('base64url') : undefined);
    const passwordHash = password === undefined ? undefined : await hashPassword(password);

    try {
      await this.prisma.inTenant(parsed.tenantId, async (tx) => {
        const now = new Date();
        const invitation = await tx.customerInvitation.findUnique({ where: { tokenHash: parsed.hash } });
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

        const claimed = await tx.customerInvitation.updateMany({
          where: { id: invitation.id, acceptedAt: null },
          data: { acceptedAt: now },
        });
        if (claimed.count === 0) {
          throw invalidInvitation();
        }
        if (google && (!google.emailVerified || google.email !== invitation.email)) {
          throw new BadRequestException("The Google account's verified email must be the invitation's email");
        }

        await lockCustomer(tx, invitation.customerId);
        if (invitation.role === 'owner' && (await hasOwner(tx, invitation.customerId))) {
          throw new ConflictException('The customer already has an owner');
        }

        let user = await tx.user.findFirst({ where: { email: invitation.email }, select: { id: true, kind: true } });
        if (user?.kind === 'staff') {
          throw staffEmail();
        }
        if (user && (await this.isMember(tx, user.id, invitation.customerId))) {
          throw new ConflictException('This person already acts for the customer');
        }
        if (!user) {
          if (!name || !passwordHash) {
            throw new BadRequestException('A name and a password or Google account are needed to create your account');
          }
          user = await tx.user.create({
            data: { email: invitation.email, passwordHash, name, locale: tenant.defaultLocale, kind: 'customer' },
            select: { id: true, kind: true },
          });
        }

        await tx.organisationMembership.create({
          data: {
            userId: user.id,
            organisationType: 'customer',
            organisationId: invitation.customerId,
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

  private async isMember(tx: Prisma.TransactionClient, userId: string, customerId: string): Promise<boolean> {
    const membership = await tx.organisationMembership.findFirst({
      where: { userId, organisationType: 'customer', organisationId: customerId },
      select: { id: true },
    });
    return membership !== null;
  }
}
