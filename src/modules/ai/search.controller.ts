import { Controller, Get, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { Authenticated } from '../identity/route-markers';
import { searchQuerySchema, searchResponseSchema } from './search-response';
import type { SearchQuery, SearchResponse } from './search-response';
import { SearchService } from './search.service';

/** Cmd+K (AI 1 spec, goal 10). */
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @ApiDoc({
    summary: 'Find orders, customers, partners and knowledge articles, at most 5 of each.',
    description:
      'Staff only. Orders by the start of their number (`order.read`); customers (`customer.read`) and partners ' +
      '(`partner.read`) by any part of their name; published articles by title. A kind you may not read is an empty list.',
    query: searchQuerySchema,
    response: searchResponseSchema,
    errors: [400, 403],
  })
  @Authenticated()
  @Get()
  search(@CurrentUser() auth: TenantAuth, @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery): Promise<SearchResponse> {
    return this.searchService.search(auth, query.q);
  }
}
