import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { GOOGLE_TOKEN_VERIFIER } from './google-token-verifier';
import type { GoogleIdentity, GoogleTokenVerifier } from './google-token-verifier';

/** Reads a Google ID token for one workspace, against that workspace's own client ids. */
@Injectable()
export class GoogleIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Inject(GOOGLE_TOKEN_VERIFIER) private readonly verifier: GoogleTokenVerifier,
  ) {}

  /** 404 when the workspace has not set up Google; 401 for any token that fails verification. */
  async identity(tenantId: string, idToken: string): Promise<GoogleIdentity> {
    const clientIds = await this.prisma.inTenant(tenantId, async (tx) => {
      const row = await tx.tenantSetting.findFirst({ where: { key: 'auth.google' }, select: { key: true } });
      return row ? (await this.settings.get(tx, 'auth.google')).clientIds : null;
    });
    if (!clientIds) {
      throw new NotFoundException('Sign in with Google is not set up for this workspace');
    }
    // Outside the transaction: the first call fetches Google's keys.
    return this.verifier.verify(idToken, clientIds);
  }
}
