import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentPartner, CurrentUser } from '../identity/auth-context';
import type { PartnerAuth, TenantAuth } from '../identity/auth-context';
import { PartnerAccess, PartnerPerson } from '../identity/route-markers';
import { invitePartnerPersonSchema } from './partner-invitations.service';
import { PartnerMembersService } from './partner-members.service';
import {
  partnerInvitationResponseSchema,
  partnerMeResponseSchema,
  partnerMembersResponseSchema,
} from './partner-response';
import type { PartnerInvitationResponse, PartnerMeResponse, PartnerMemberResponse } from './partner-response';

const idParam = new ZodValidationPipe(z.uuid());

/** Where partner people act for their partners (Partners spec, goal 1). */
@Controller('partner-portal')
export class PartnerPortalController {
  constructor(private readonly members: PartnerMembersService) {}

  @ApiDoc({
    summary: "You, and the partners you act for, with your role and each partner's status.",
    description: 'For partner people only; staff and customer people get 403.',
    response: partnerMeResponseSchema,
  })
  @PartnerPerson()
  @Get('me')
  me(@CurrentUser() auth: TenantAuth): Promise<PartnerMeResponse> {
    return this.members.me(auth);
  }

  @ApiDoc({
    summary: "The partner's people and their roles, in the order they joined.",
    response: partnerMembersResponseSchema,
    errors: [400, 404],
  })
  @PartnerAccess('member')
  @Get('partners/:partnerId/members')
  list(@CurrentPartner() partner: PartnerAuth): Promise<{ data: PartnerMemberResponse[] }> {
    return this.members.list(partner.tenantId, partner.partnerId);
  }

  @ApiDoc({
    summary: 'Invite a colleague by email to act for the partner, with the role they get on accepting.',
    description:
      "The token goes only to the invitee's inbox. Only the owner invites an owner (403), and only while the partner has none (409). " +
      'Refused with 409 for a staff or customer email, or someone already acting for the partner.',
    body: invitePartnerPersonSchema,
    response: partnerInvitationResponseSchema,
    errors: [400, 404, 409],
  })
  @PartnerAccess('admin')
  @Post('partners/:partnerId/invitations')
  invite(
    @CurrentPartner() partner: PartnerAuth,
    @Body(new ZodValidationPipe(invitePartnerPersonSchema)) body: z.infer<typeof invitePartnerPersonSchema>,
  ): Promise<PartnerInvitationResponse> {
    return this.members.invite(partner, body);
  }

  @ApiDoc({
    summary: 'Remove a colleague from the partner.',
    description: 'The owner is never removed (409). The person keeps their account and any other partners.',
    errors: [400, 404, 409],
  })
  @PartnerAccess('admin')
  @Delete('partners/:partnerId/members/:userId')
  @HttpCode(204)
  async remove(@CurrentPartner() partner: PartnerAuth, @Param('userId', idParam) userId: string): Promise<void> {
    await this.members.remove(partner, userId);
  }
}
