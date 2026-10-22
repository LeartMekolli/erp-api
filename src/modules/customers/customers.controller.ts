import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../common/pagination/page';
import type { Page } from '../../common/pagination/page';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { customerResponseSchema } from './customer-response';
import type { CustomerResponse } from './customer-response';
import { CustomersService, createCustomerSchema, updateCustomerSchema } from './customers.service';

const idParam = new ZodValidationPipe(z.uuid());

/** Customer organisations, managed by staff (Customers spec). */
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

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
}
