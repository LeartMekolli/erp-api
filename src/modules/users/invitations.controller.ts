import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { emailSchema } from '../identity/email';
import { RequirePermission } from '../identity/route-markers';
import { InvitationsService } from './invitations.service';
import { invitationResponseSchema } from './invitation-response';
import type { InvitationResponse } from './invitation-response';

const inviteSchema = z.object({ email: emailSchema, role_id: z.uuid() });

const listSchema = paginationQuerySchema.extend({ status: z.enum(['waiting', 'expired']).optional() });

const idSchema = z.uuid();

@Controller('users/invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @ApiDoc({
    summary: 'Invite someone by email, with the role they get on accepting.',
    description:
      "Answers the invitation with its role, who invited, expiry and `email_status` (`sending`, `sent`, `failed`, or null when no email was raised); the token goes only to the invitee's inbox. " +
      "Inviting an email that already has a waiting invitation replaces it, so the caller needs the permissions of both roles. " +
      '403 `exceeds_own_permissions` (the role has permissions the caller lacks) and `owner_only` (the owner role, or replacing an owner invitation). ' +
      '409 `email_is_staff` (answers the `user` with id, name and status) and `email_is_other_kind` (a customer or partner person).',
    body: inviteSchema,
    response: invitationResponseSchema,
    errors: [400, 401, 403, 404, 409],
  })
  @RequirePermission('user.invite')
  @Post()
  create(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(inviteSchema)) body: z.infer<typeof inviteSchema>,
  ): Promise<InvitationResponse> {
    return this.invitations.invite(auth, { email: body.email, roleId: body.role_id });
  }

  @ApiDoc({
    summary: 'List the staff invitations that are waiting or have expired, newest first.',
    description:
      'A page of invitations: `data` and `next_cursor`, which goes back as `cursor` for the next page. ' +
      'Only the newest invitation of each email is listed. Accepted and cancelled invitations are left out, ' +
      'and so are those whose email now belongs to a staff member. `status` keeps only the `waiting` or only the `expired` ones. ' +
      '`email_status` is `sending`, `sent`, `failed`, or null when no email was raised.',
    query: listSchema,
    response: pageSchema(invitationResponseSchema),
    errors: [400, 401, 403],
  })
  @RequirePermission('user.read')
  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>,
  ): Promise<Page<InvitationResponse>> {
    return this.invitations.list(tenantId, query);
  }

  @ApiDoc({
    summary: 'Cancel an invitation: its link stops working and it leaves the list.',
    description:
      'Idempotent: cancelling a cancelled invitation answers 204 and records nothing. Cancelling takes the role back, ' +
      'so only an owner may cancel an owner invitation (403 `owner_only`), and every other role must hold only permissions ' +
      'the caller has (403 `exceeds_own_permissions`). An invitation that was already accepted answers 409 `already_accepted`.',
    errors: [400, 401, 403, 404, 409],
  })
  @RequirePermission('user.invite')
  @Delete(':id')
  @HttpCode(204)
  async cancel(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.invitations.cancel(auth, id);
  }
}
