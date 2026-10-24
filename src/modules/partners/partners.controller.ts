import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { PartnerInvitationsService, invitePartnerPersonSchema } from './partner-invitations.service';
import { PartnerMembersService } from './partner-members.service';
import {
  partnerInvitationResponseSchema,
  partnerMembersResponseSchema,
  partnerResponseSchema,
} from './partner-response';
import type { PartnerInvitationResponse, PartnerMemberResponse, PartnerResponse } from './partner-response';
import {
  PartnersService,
  agreementSchema,
  createPartnerSchema,
  partnerListQuerySchema,
  updatePartnerSchema,
} from './partners.service';
import type { PartnerListQuery } from './partners.service';

const idParam = new ZodValidationPipe(z.uuid());

/** Partner workshops, managed by staff (Partners spec, goals 2 and 3). */
@Controller('partners')
export class PartnersController {
  constructor(
    private readonly partners: PartnersService,
    private readonly invitations: PartnerInvitationsService,
    private readonly members: PartnerMembersService,
  ) {}

  @ApiDoc({
    summary: 'Add a partner workshop; it starts being set up and is offered no jobs until approved.',
    body: createPartnerSchema,
    response: partnerResponseSchema,
    errors: [400],
  })
  @RequirePermission('partner.write')
  @Post()
  create(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createPartnerSchema)) body: z.infer<typeof createPartnerSchema>,
  ): Promise<PartnerResponse> {
    return this.partners.create(auth, body);
  }

  @ApiDoc({
    summary: 'Partner workshops, newest first, optionally only those in one status.',
    query: partnerListQuerySchema,
    response: pageSchema(partnerResponseSchema),
    errors: [400],
  })
  @RequirePermission('partner.read')
  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(partnerListQuerySchema)) query: PartnerListQuery,
  ): Promise<Page<PartnerResponse>> {
    return this.partners.list(tenantId, query);
  }

  @ApiDoc({ summary: 'A partner workshop.', response: partnerResponseSchema, errors: [400, 404] })
  @RequirePermission('partner.read')
  @Get(':id')
  get(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<PartnerResponse> {
    return this.partners.get(tenantId, id);
  }

  @ApiDoc({
    summary: "Change a partner's own name or the name customers see.",
    body: updatePartnerSchema,
    response: partnerResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('partner.write')
  @Patch(':id')
  update(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updatePartnerSchema)) body: z.infer<typeof updatePartnerSchema>,
  ): Promise<PartnerResponse> {
    return this.partners.update(auth, id, body);
  }

  @ApiDoc({
    summary: "Put the partner's signed agreement on file, with the date it was signed.",
    description: 'The file version must be uploaded through Files first; one still uploading is a 404.',
    body: agreementSchema,
    response: partnerResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('partner.write')
  @Put(':id/agreement')
  agreement(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(agreementSchema)) body: z.infer<typeof agreementSchema>,
  ): Promise<PartnerResponse> {
    return this.partners.setAgreement(auth, id, body);
  }

  @ApiDoc({
    summary: 'Approve a partner, so it can be offered jobs.',
    description: 'Needs the signed agreement on file; an approved partner is a 409. A suspended partner can be approved again.',
    response: partnerResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('partner.write')
  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<PartnerResponse> {
    return this.partners.approve(auth, id);
  }

  @ApiDoc({
    summary: 'Suspend a partner: it is offered no new jobs, and its accepted jobs carry on.',
    response: partnerResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('partner.write')
  @Post(':id/suspend')
  @HttpCode(200)
  suspend(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<PartnerResponse> {
    return this.partners.suspend(auth, id);
  }

  @ApiDoc({
    summary: 'Invite someone by email to act for the partner, with the role they get on accepting.',
    description:
      "The token goes only to the invitee's inbox. Someone who already acts for another partner of the workspace accepts without a new password. " +
      'Refused with 409 for a staff or customer email, someone already acting for the partner, or a second owner.',
    body: invitePartnerPersonSchema,
    response: partnerInvitationResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('partner.write')
  @Post(':id/invitations')
  invite(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(invitePartnerPersonSchema)) body: z.infer<typeof invitePartnerPersonSchema>,
  ): Promise<PartnerInvitationResponse> {
    return this.invitations.invite(auth.tenantId, id, { email: body.email, role: body.role, invitedByUserId: auth.userId });
  }

  @ApiDoc({
    summary: "The partner's people and their roles, in the order they joined.",
    response: partnerMembersResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('partner.read')
  @Get(':id/members')
  listMembers(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<{ data: PartnerMemberResponse[] }> {
    return this.members.list(tenantId, id);
  }
}
