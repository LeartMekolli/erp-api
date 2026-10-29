import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Page } from '../../../common/pagination/page';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../../docs/api-doc';
import { CurrentUser } from '../../identity/auth-context';
import type { TenantAuth } from '../../identity/auth-context';
import { Authenticated, RequirePermission } from '../../identity/route-markers';
import {
  articleListQuerySchema,
  articleListResponseSchema,
  articleResponseSchema,
  createArticleSchema,
  updateArticleSchema,
} from './article-response';
import type { ArticleListItem, ArticleListQuery, ArticleResponse, CreateArticle, UpdateArticle } from './article-response';
import { ArticlesService } from './articles.service';

const idParam = new ZodValidationPipe(z.uuid());
const ATTACHMENTS = 'Attachments are files of this workspace, PDF or plain text; their text is searched with the article.';

/** The knowledge base (AI 1 spec, goal 14): written with `knowledge.write`, read by every staff member. */
@Controller('knowledge/articles')
export class ArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  @ApiDoc({
    summary: 'Knowledge articles, newest first; `q` searches titles.',
    description: 'Staff only. Drafts and archived articles are listed only for staff with `knowledge.write`.',
    query: articleListQuerySchema,
    response: articleListResponseSchema,
    errors: [400, 403],
  })
  @Authenticated()
  @Get()
  list(@CurrentUser() auth: TenantAuth, @Query(new ZodValidationPipe(articleListQuerySchema)) query: ArticleListQuery): Promise<Page<ArticleListItem>> {
    return this.articles.list(auth, query);
  }

  @ApiDoc({
    summary: 'One knowledge article, with its attachments.',
    description: 'Staff only. A draft or an archived article is a 404 without `knowledge.write`.',
    response: articleResponseSchema,
    errors: [400, 403, 404],
  })
  @Authenticated()
  @Get(':id')
  get(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<ArticleResponse> {
    return this.articles.get(auth, id);
  }

  @ApiDoc({
    summary: 'Write a knowledge article, as a draft.',
    description: ATTACHMENTS,
    body: createArticleSchema,
    response: articleResponseSchema,
    errors: [400],
  })
  @RequirePermission('knowledge.write')
  @Post()
  create(@CurrentUser() auth: TenantAuth, @Body(new ZodValidationPipe(createArticleSchema)) body: CreateArticle): Promise<ArticleResponse> {
    return this.articles.create(auth, body);
  }

  @ApiDoc({
    summary: 'Change a knowledge article; a published one is searched as changed shortly after.',
    description: `${ATTACHMENTS} \`attachment_file_ids\` replaces the attachments.`,
    body: updateArticleSchema,
    response: articleResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('knowledge.write')
  @Patch(':id')
  update(
    @CurrentUser() auth: TenantAuth,
    @Param('id', idParam) id: string,
    @Body(new ZodValidationPipe(updateArticleSchema)) body: UpdateArticle,
  ): Promise<ArticleResponse> {
    return this.articles.update(auth, id, body);
  }

  @ApiDoc({
    summary: 'Publish a knowledge article: every staff member reads it, and the AI searches it.',
    description: 'Publishing a published article changes nothing.',
    response: articleResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('knowledge.write')
  @Post(':id/publish')
  @HttpCode(200)
  publish(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<ArticleResponse> {
    return this.articles.publish(auth, id);
  }

  @ApiDoc({
    summary: 'Archive a knowledge article: hidden from staff who do not write, and no longer searched.',
    description: 'Archiving an archived article changes nothing; publishing it again brings it back.',
    response: articleResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('knowledge.write')
  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<ArticleResponse> {
    return this.articles.archive(auth, id);
  }
}
