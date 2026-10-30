import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { pageSchema } from '../../../common/pagination/page';
import type { Page } from '../../../common/pagination/page';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentCustomer } from '../../identity/auth-context';
import type { CustomerAuth } from '../../identity/auth-context';
import { CustomerAccess } from '../../identity/route-markers';
import { BrandContentService } from './brand-content';
import { brandContentBodySchema, customerResultListQuerySchema, customerResultSchema, startedSchema } from './customer-result-response';
import type { BrandContentBody, CustomerResultListQuery, CustomerResultResponse } from './customer-result-response';
import { CustomerToolsService } from './customer-tools.service';

const idParam = new ZodValidationPipe(z.uuid());

/** Said of every tool: how it is paid, and when it is refused. */
const PAID =
  'Answers 202 with the run id; poll `GET …/ai/runs/{id}` for the result. Charged when queued, given back if the run fails. ' +
  "403 when the customer's plan doesn't include the tool; 409 without enough credits or when the workspace's AI limit is used, " +
  'and nothing is charged.';

/** The customer AI tools and their history, in the portal (AI 2 spec). */
@Controller('portal/customers/:customerId/ai')
export class CustomerToolsController {
  constructor(
    private readonly tools: CustomerToolsService,
    private readonly brandContent: BrandContentService,
  ) {}

  @ApiDoc({
    summary: 'Catalog text for a product, written from the brand profile: names, a short and a long description, tags.',
    description: `Give one of \`product_id\` (a product of the customer's catalog) or \`description\`. Needs a brand profile (409). ${PAID}`,
    body: brandContentBodySchema,
    response: startedSchema,
    errors: [400, 404, 409],
  })
  @CustomerAccess('buyer')
  @Post('brand-content')
  @HttpCode(202)
  startBrandContent(
    @CurrentCustomer() customer: CustomerAuth,
    @Body(new ZodValidationPipe(brandContentBodySchema)) body: BrandContentBody,
  ): Promise<{ id: string }> {
    return this.brandContent.start(customer, body);
  }

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
