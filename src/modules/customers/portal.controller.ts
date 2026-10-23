import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentCustomer, CurrentUser } from '../identity/auth-context';
import type { CustomerAuth, TenantAuth } from '../identity/auth-context';
import { emailSchema } from '../identity/email';
import { Authenticated, CustomerAccess } from '../identity/route-markers';
import {
  customerInvitationResponseSchema,
  customerMemberResponseSchema,
  portalMeResponseSchema,
} from './customer-response';
import type { CustomerInvitationResponse, CustomerMemberResponse, PortalMeResponse } from './customer-response';
import { CUSTOMER_ROLES } from './customer-roles';
import { CustomersService } from './customers.service';
import { PortalMembersService } from './portal-members.service';

const idParam = new ZodValidationPipe(z.uuid());

const inviteSchema = z.object({ email: emailSchema, role: z.enum(CUSTOMER_ROLES) });

const changeRoleSchema = z.object({
  /** `owner`, from the owner, hands over: the owner becomes an admin. */
  role: z.enum(CUSTOMER_ROLES),
});

const membersResponseSchema = z.strictObject({ data: z.array(customerMemberResponseSchema) });

/** Where customer people act for their organisations (Customers spec). */
@Controller('portal')
export class PortalController {
  constructor(
    private readonly members: PortalMembersService,
    private readonly customers: CustomersService,
  ) {}

  @ApiDoc({
    summary: 'You, and the active customers you act for with your role in each.',
    description: 'For customer people only; staff get 403.',
    response: portalMeResponseSchema,
    errors: [403],
  })
  @Authenticated()
  @Get('me')
  me(@CurrentUser() auth: TenantAuth): Promise<PortalMeResponse> {
    return this.members.me(auth);
  }

  @ApiDoc({
    summary: "The customer's people and their roles, in the order they joined.",
    response: membersResponseSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get('customers/:customerId/members')
  list(@CurrentCustomer() customer: CustomerAuth): Promise<{ data: CustomerMemberResponse[] }> {
    return this.customers.members(customer.tenantId, customer.customerId);
  }

  @ApiDoc({
    summary: 'Invite a colleague by email to act for the customer, with the role they get on accepting.',
    description:
      "The token goes only to the invitee's inbox. Only the owner invites an owner (403), and only while the customer has none (409). " +
      'Refused with 409 for a staff email or someone already acting for the customer.',
    body: inviteSchema,
    response: customerInvitationResponseSchema,
    errors: [400, 404, 409],
  })
  @CustomerAccess('admin')
  @Post('customers/:customerId/invitations')
  invite(
    @CurrentCustomer() customer: CustomerAuth,
    @Body(new ZodValidationPipe(inviteSchema)) body: z.infer<typeof inviteSchema>,
  ): Promise<CustomerInvitationResponse> {
    return this.members.invite(customer, body);
  }

  @ApiDoc({
    summary: "Change a colleague's role at the customer.",
    description:
      'Only the owner makes someone owner, which hands over: the owner becomes an admin (403 for anyone else). ' +
      'The owner cannot step down any other way (409).',
    body: changeRoleSchema,
    response: customerMemberResponseSchema,
    errors: [400, 404, 409],
  })
  @CustomerAccess('admin')
  @Patch('customers/:customerId/members/:userId')
  changeRole(
    @CurrentCustomer() customer: CustomerAuth,
    @Param('userId', idParam) userId: string,
    @Body(new ZodValidationPipe(changeRoleSchema)) body: z.infer<typeof changeRoleSchema>,
  ): Promise<CustomerMemberResponse> {
    return this.members.changeRole(customer, userId, body.role);
  }

  @ApiDoc({
    summary: 'Remove a colleague from the customer, or leave it yourself.',
    description:
      'Owners and admins remove others; anyone may remove themselves. The owner is never removed (409). ' +
      'The person keeps their account and any other customers.',
    errors: [400, 404, 409],
  })
  @CustomerAccess('viewer')
  @Delete('customers/:customerId/members/:userId')
  @HttpCode(204)
  async remove(@CurrentCustomer() customer: CustomerAuth, @Param('userId', idParam) userId: string): Promise<void> {
    await this.members.remove(customer, userId);
  }
}
