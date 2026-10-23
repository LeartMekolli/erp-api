import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { GoogleIdentityService } from './google-identity.service';
import { SessionService } from './session.service';
import type { SessionTokens } from './session.service';

function refused(): UnauthorizedException {
  return new UnauthorizedException('Invalid Google sign-in');
}

/**
 * Sign in with Google, for staff and customer people alike (Customers spec,
 * goal 4). A Google account reaches the user it is linked to by its subject;
 * the first time, it is linked to the user with its email, but only if Google
 * says that email is verified. An unknown email is refused: there is no open
 * signup. A disabled user or workspace is refused as password login is.
 */
@Injectable()
export class GoogleSignInService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleIdentityService,
    private readonly sessions: SessionService,
  ) {}

  async signIn(slug: string | undefined, idToken: string): Promise<SessionTokens> {
    const tenant = slug
      ? await this.prisma.tenant.findUnique({ where: { slug }, select: { id: true, status: true } })
      : null;
    if (!tenant) {
      throw refused();
    }

    const identity = await this.google.identity(tenant.id, idToken);

    const session = await this.prisma.inTenant(tenant.id, async (tx) => {
      const linked = await tx.externalIdentity.findUnique({
        where: { tenantId_provider_subject: { tenantId: tenant.id, provider: 'google', subject: identity.subject } },
        select: { user: { select: { id: true, status: true } } },
      });
      let user = linked?.user ?? null;
      if (!user && identity.emailVerified) {
        user = await tx.user.findFirst({ where: { email: identity.email }, select: { id: true, status: true } });
        if (user && user.status === 'active') {
          await tx.externalIdentity.create({ data: { provider: 'google', subject: identity.subject, userId: user.id } });
        }
      }
      if (!user || user.status !== 'active' || tenant.status !== 'active') {
        throw refused();
      }
      return { userId: user.id, refreshToken: await this.sessions.openSession(tx, tenant.id, user.id) };
    });

    return this.sessions.tokensFor(tenant.id, session.userId, session.refreshToken);
  }
}
