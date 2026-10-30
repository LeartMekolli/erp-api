import { Controller, Delete, Get, HttpCode, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema } from '../../../common/pagination/page';
import type { Page } from '../../../common/pagination/page';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentCustomer } from '../../identity/auth-context';
import type { CustomerAuth } from '../../identity/auth-context';
import { CustomerAccess } from '../../identity/route-markers';
import { customerResultListQuerySchema, customerResultSchema } from './customer-result-response';
import type { CustomerResultListQuery, CustomerResultResponse } from './customer-result-response';
import { CustomerToolsService } from './customer-tools.service';

const idParam = new ZodValidationPipe(z.uuid());

/** The customer AI tools and their history, in the portal (AI 2 spec). */
@Controller('portal/customers/:customerId/ai')
export class CustomerToolsController {
  constructor(private readonly tools: CustomerToolsService) {}

  @ApiDoc({
    summary: 'One use of an AI tool, with its result once it is done.',
    description:
      'Poll this after starting a tool. A failed run says so plainly and gives its credits back. ' +
      "Another customer's run, or one deleted from the history, is a 404.",
    response: customerResultSchema,
    errors: [400, 404],
  })
  @CustomerAccess('viewer')
  @Get('runs/:id')
  run(@CurrentCustomer() customer: CustomerAuth, @Param('id', idParam) id: string): Promise<CustomerResultResponse> {
    return this.tools.get(customer, id);
  }

  @ApiDoc({
    summary: "The customer's uses of the AI tools, newest first, optionally of one tool.",
    description: 'Each with its input, result, credits charged and who asked. Pass `next_cursor` back as `cursor` for the next page.',
    query: customerResultListQuerySchema,
    response: pageSchema(customerResultSchema),
    errors: [400],
  })
  @CustomerAccess('viewer')
  @Get('results')
  list(
    @CurrentCustomer() customer: CustomerAuth,
    @Query(new ZodValidationPipe(customerResultListQuerySchema)) query: CustomerResultListQuery,
  ): Promise<Page<CustomerResultResponse>> {
    return this.tools.list(customer, query);
  }

  @ApiDoc({
    summary: 'Delete a result from the history; an image loses its file.',
    description: 'No credits come back. A run still running is a 409.',
    errors: [400, 404, 409],
  })
  @CustomerAccess('admin')
  @Delete('results/:id')
  @HttpCode(204)
  async remove(@CurrentCustomer() customer: CustomerAuth, @Param('id', idParam) id: string): Promise<void> {
    await this.tools.remove(customer, id);
  }
}
