import { Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { emailSchema } from '../identity/email';
import { RequirePermission } from '../identity/route-markers';
import { InvitationsService } from './invitations.service';
import { invitationResponseSchema } from './invitation-response';
import type { InvitationResponse } from './invitation-response';

const inviteSchema = z.object({ email: emailSchema, role_id: z.uuid() });

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
}
