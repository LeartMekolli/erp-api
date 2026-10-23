import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { emailSchema } from '../identity/email';
import { RequirePermission } from '../identity/route-markers';
import { CustomerInvitationsService } from './customer-invitations.service';
import {
  customerInvitationResponseSchema,
  customerMemberResponseSchema,
  customerResponseSchema,
} from './customer-response';
import type { CustomerInvitationResponse, CustomerMemberResponse, CustomerResponse } from './customer-response';
import { CUSTOMER_ROLES } from './customer-roles';
import { CustomersService, createCustomerSchema, updateCustomerSchema, updateMemberSchema } from './customers.service';

const idParam = new ZodValidationPipe(z.uuid());

const inviteSchema = z.object({ email: emailSchema, role: z.enum(CUSTOMER_ROLES) });

const membersResponseSchema = z.strictObject({ data: z.array(customerMemberResponseSchema) });

/** Customer organisations, managed by staff (Customers spec). */
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly invitations: CustomerInvitationsService,
  ) {}

  @ApiDoc({
    summary: 'Create a customer organisation: a brand, or one person on their own.',
    body: createCustomerSchema,
    response: customerResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('customer.write')
  @Post()
  create(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createCustomerSchema)) body: z.infer<typeof createCustomerSchema>,
  ): Promise<CustomerResponse> {
    return this.customers.create(auth, body);
  }

  @ApiDoc({
    summary: 'Customer organisations, newest first.',
    query: paginationQuerySchema,
    response: pageSchema(customerResponseSchema),
    errors: [400],
  })
  @RequirePermission('customer.read')
  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: z.infer<typeof paginationQuerySchema>,
  ): Promise<Page<CustomerResponse>> {
    return this.customers.list(tenantId, query);
  }

  @ApiDoc({ summary: 'A customer organisation.', response: customerResponseSchema, errors: [400, 404] })
  @RequirePermission('customer.read')
  @Get(':id')
  get(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<CustomerResponse> {
    return this.customers.get(tenantId, id);
  }

  @ApiDoc({
    summary: "Change a customer's name, status or customer group.",
    description: 'A disabled customer keeps its data; its people cannot act for it until it is active again.',
    body: updateCustomerSchema,
    response: customerResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('customer.write')
  @Patch(':id')
  update(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateCustomerSchema)) body: z.infer<typeof updateCustomerSchema>,
  ): Promise<CustomerResponse> {
    return this.customers.update(auth, id, body);
  }

  @ApiDoc({
    summary: 'Invite someone by email to act for the customer, with the role they get on accepting.',
    description:
      "The token goes only to the invitee's inbox; the link points at the workspace's customer site when it has one. " +
      'Someone who already acts for another customer of the workspace accepts without a new password. ' +
      'Refused with 409 for a staff email, someone already acting for the customer, or a second owner.',
    body: inviteSchema,
    response: customerInvitationResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('customer.write')
  @Post(':id/invitations')
  invite(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(inviteSchema)) body: z.infer<typeof inviteSchema>,
  ): Promise<CustomerInvitationResponse> {
    return this.invitations.invite(auth.tenantId, id, { email: body.email, role: body.role, invitedByUserId: auth.userId });
  }

  @ApiDoc({
    summary: "The customer's people and their roles, in the order they joined.",
    response: membersResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('customer.read')
  @Get(':id/members')
  members(@CurrentTenant() tenantId: string, @Param('id', idParam) id: string): Promise<{ data: CustomerMemberResponse[] }> {
    return this.customers.members(tenantId, id);
  }

  @ApiDoc({
    summary: "Change a person's role at the customer, or disable or re-enable the person.",
    description:
      'Making someone owner turns the current owner into an admin; taking the owner role away otherwise is a 409. ' +
      "The status is the person's own, for every customer they act for, and applies from their next request.",
    body: updateMemberSchema,
    response: customerMemberResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('customer.write')
  @Patch(':id/members/:userId')
  updateMember(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Param('userId', idParam) userId: string,
    @Body(new ZodValidationPipe(updateMemberSchema)) body: z.infer<typeof updateMemberSchema>,
  ): Promise<CustomerMemberResponse> {
    return this.customers.updateMember(auth, id, userId, body);
  }
}
