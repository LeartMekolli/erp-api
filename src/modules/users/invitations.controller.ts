import { Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { emailSchema } from '../identity/email';
import { RequirePermission } from '../identity/route-markers';
import { InvitationsService } from './invitations.service';
import type { InvitationResponse } from './invitations.service';

const inviteSchema = z.object({ email: emailSchema, role_id: z.uuid() });

@Controller('users/invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @ApiDoc({
    summary: 'Invite someone by email, with the role they get on accepting.',
    description: "Answers the invitation id, email and expiry; the token goes only to the invitee's inbox.",
    body: inviteSchema,
    errors: [400, 401, 403, 404, 409],
  })
  @RequirePermission('user.invite')
  @Post()
  create(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(inviteSchema)) body: z.infer<typeof inviteSchema>,
  ): Promise<InvitationResponse> {
    return this.invitations.invite(auth.tenantId, auth.userId, { email: body.email, roleId: body.role_id });
  }
}
