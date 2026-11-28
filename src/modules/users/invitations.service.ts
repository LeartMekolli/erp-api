import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { decodeCursor } from '../../common/pagination/cursor';
import { Page, toPage } from '../../common/pagination/page';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { TenantAuth } from '../identity/auth-context';
import { assertMayChangeRoles, callerIsOwner } from '../identity/grants';
import type { RoleRef } from '../identity/grants';
import { IDENTITY_NOTIFIER } from '../identity/identity-notifier';
import type { IdentityNotifier } from '../identity/identity-notifier';
import { createInvitation } from '../identity/invitations';
import { emailStatusOf, toInvitationResponse } from './invitation-response';
import type { InvitationEmailStatus, InvitationResponse } from './invitation-response';

const roleSelect = { id: true, name: true, isSystem: true, permissions: { select: { permission: true } } } as const;

function refOf(role: { name: string; isSystem: boolean; permissions: { permission: string }[] }): RoleRef {
  return { name: role.name, isSystem: role.isSystem, permissions: role.permissions.map((row) => row.permission) };
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    @Inject(IDENTITY_NOTIFIER) private readonly notifier: IdentityNotifier,
  ) {}

  /**
   * The token goes to the notifier, after commit, and never into the response:
   * whoever can read the response is not necessarily the invitee (D78).
   * Inviting again replaces a waiting invitation, so the caller needs the rules
   * for the new role and for each role the replaced invitations carried.
   */
  async invite(auth: TenantAuth, input: { email: string; roleId: string }): Promise<InvitationResponse> {
    const tenantId = auth.tenantId;
    const created = await this.prisma.inTenant(tenantId, async (tx) => {
      // A role id from another tenant is invisible here, so it is "not found".
      const role = await tx.role.findUnique({ where: { id: input.roleId }, select: roleSelect });
      if (!role) {
        throw new NotFoundException('Role not found');
      }

      const now = new Date();
      const waiting = await tx.invitation.findMany({
        where: { email: input.email, acceptedAt: null, cancelledAt: null, expiresAt: { gt: now } },
        select: { role: { select: roleSelect } },
      });
      assertMayChangeRoles(
        auth,
        await callerIsOwner(tx, auth.userId),
        [refOf(role), ...waiting.map((row) => refOf(row.role))],
        [],
      );

      const taken = await tx.user.findFirst({
        where: { email: input.email },
        select: { id: true, name: true, status: true, kind: true },
      });
      if (taken) {
        if (taken.kind === 'staff') {
          throw new ConflictException({
            code: 'email_is_staff',
            message: 'This email already belongs to someone on your team',
            user: { id: taken.id, name: taken.name, status: taken.status },
          });
        }
        throw new ConflictException({
          code: 'email_is_other_kind',
          message: 'This email belongs to a customer or partner person and cannot be invited as staff',
        });
      }

      const invitation = await createInvitation(tx, tenantId, {
        email: input.email,
        roleId: input.roleId,
        invitedByUserId: auth.userId,
      });
      const stored = await tx.invitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
        select: { createdAt: true },
      });
      const inviter = await tx.user.findUnique({ where: { id: auth.userId }, select: { id: true, name: true } });
      return {
        invitation,
        row: {
          id: invitation.invitationId,
          email: input.email,
          expiresAt: invitation.expiresAt,
          createdAt: stored.createdAt,
          role: { id: role.id, name: role.name },
          invitedBy: inviter,
        },
      };
    });

    const invitationId = created.invitation.invitationId;
    let emailStatus: InvitationEmailStatus | null;
    let raised = true;
    try {
      await this.notifier.invitationCreated({
        tenantId,
        invitationId,
        email: input.email,
        token: created.invitation.token,
      });
    } catch (error) {
      this.logger.error({ err: error, tenantId, invitationId }, 'a staff invitation email failed');
      raised = false;
    }
    if (!raised) {
      emailStatus = 'failed';
    } else {
      try {
        emailStatus = await this.prisma.inTenant(
          tenantId,
          async (tx) => (await emailStatusOf(tx, [invitationId])).get(invitationId) ?? null,
        );
      } catch (error) {
        this.logger.error({ err: error, tenantId, invitationId }, "reading a staff invitation's email status failed");
        emailStatus = null;
      }
    }

    return toInvitationResponse(created.row, emailStatus, new Date());
  }

  /**
   * Waiting and expired invitations, newest first. Only the newest invitation of each email counts, decided
   * before paging: a replaced one stays in the table as expired and would otherwise show beside its successor.
   * An invitation that was accepted or cancelled, or whose email now belongs to staff, is not listed.
   */
  async list(
    tenantId: string,
    query: { limit: number; cursor?: string; status?: 'waiting' | 'expired' },
  ): Promise<Page<InvitationResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    const now = new Date();
    // `expires_at` is a zone-less UTC timestamp; same conversion as reporting/series.ts.
    const nowUtc = Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    return this.prisma.inTenant(tenantId, async (tx) => {
      const found = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT i.id
        FROM (
          SELECT DISTINCT ON (email) id, email, expires_at, accepted_at, cancelled_at
          FROM invitation
          WHERE tenant_id = ${tenantId}::uuid
          ORDER BY email, created_at DESC, id DESC
        ) i
        WHERE i.accepted_at IS NULL
          AND i.cancelled_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM app_user u WHERE u.tenant_id = ${tenantId}::uuid AND u.email = i.email AND u.kind = 'staff'
          )
          ${query.status === 'waiting' ? Prisma.sql`AND i.expires_at > ${nowUtc}` : Prisma.empty}
          ${query.status === 'expired' ? Prisma.sql`AND i.expires_at <= ${nowUtc}` : Prisma.empty}
          ${after ? Prisma.sql`AND i.id < ${after.id}::uuid` : Prisma.empty}
        ORDER BY i.id DESC
        LIMIT ${query.limit + 1}
      `);
      const page = toPage(found, query.limit, secret);
      const ids = page.data.map((row) => row.id);

      const rows = await tx.invitation.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          email: true,
          expiresAt: true,
          createdAt: true,
          invitedByUserId: true,
          role: { select: { id: true, name: true } },
        },
        orderBy: { id: 'desc' },
      });
      const inviterIds = [...new Set(rows.flatMap((row) => (row.invitedByUserId ? [row.invitedByUserId] : [])))];
      const inviters = await tx.user.findMany({
        where: { id: { in: inviterIds } },
        select: { id: true, name: true },
      });
      const inviterOf = new Map(inviters.map((inviter) => [inviter.id, inviter]));
      const statuses = await emailStatusOf(tx, ids);

      return {
        data: rows.map((row) =>
          toInvitationResponse(
            { ...row, invitedBy: row.invitedByUserId ? (inviterOf.get(row.invitedByUserId) ?? null) : null },
            statuses.get(row.id) ?? null,
            now,
          ),
        ),
        next_cursor: page.next_cursor,
      };
    });
  }

  /**
   * Cancelling takes the role back, so the same rules apply as for removing it from a person. Idempotent:
   * a cancelled invitation answers 204 and records nothing. The token stops working through `expiresAt`, so
   * accepting it fails like an expired one.
   */
  async cancel(auth: TenantAuth, id: string): Promise<void> {
    await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const invitation = await tx.invitation.findUnique({
        where: { id },
        select: { id: true, email: true, expiresAt: true, acceptedAt: true, cancelledAt: true, role: { select: roleSelect } },
      });
      if (!invitation) {
        throw new NotFoundException('Invitation not found');
      }

      // Before the state checks, so the refusal is the same whatever state the invitation is in.
      assertMayChangeRoles(auth, await callerIsOwner(tx, auth.userId), [], [refOf(invitation.role)]);

      const alreadyAccepted = () =>
        new ConflictException({ code: 'already_accepted', message: 'This invitation was already accepted' });
      if (invitation.acceptedAt) {
        throw alreadyAccepted();
      }
      if (invitation.cancelledAt) {
        return;
      }

      const now = new Date();
      const { count } = await tx.invitation.updateMany({
        where: { id, acceptedAt: null, cancelledAt: null },
        data: { cancelledAt: now, ...(invitation.expiresAt > now ? { expiresAt: now } : {}) },
      });
      if (count === 0) {
        // Accepted or cancelled by someone else since the read.
        const current = await tx.invitation.findUnique({ where: { id }, select: { acceptedAt: true } });
        if (current?.acceptedAt) {
          throw alreadyAccepted();
        }
        return;
      }
      await this.audit.record(tx, {
        actor: { type: 'user', id: auth.userId },
        action: 'invitation.cancelled',
        subject: { type: 'invitation', id },
        after: { email: invitation.email, role: invitation.role.name },
      });
    });
  }
}
