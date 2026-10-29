import { z } from 'zod';
import { pageSchema, paginationQuerySchema } from '../../../common/pagination/page';

export const ARTICLE_STATUSES = ['draft', 'published', 'archived'] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

/** What an article's text may be read from: the knowledge job extracts PDF and plain text only. */
export const ATTACHMENT_TYPES = ['application/pdf', 'text/plain'] as const;

const tags = z.array(z.string().trim().min(1).max(40)).max(20);
const attachmentIds = z.array(z.uuid()).max(10);

export const createArticleSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  // Markdown.
  body: z.string().max(50_000),
  tags: tags.default([]),
  attachment_file_ids: attachmentIds.default([]),
});
export type CreateArticle = z.infer<typeof createArticleSchema>;

export const updateArticleSchema = z
  .strictObject({
    title: createArticleSchema.shape.title,
    body: createArticleSchema.shape.body,
    tags,
    attachment_file_ids: attachmentIds,
  })
  .partial();
export type UpdateArticle = z.infer<typeof updateArticleSchema>;

export const articleListQuerySchema = paginationQuerySchema.extend({
  // Words in the title.
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(ARTICLE_STATUSES).optional(),
});
export type ArticleListQuery = z.infer<typeof articleListQuerySchema>;

export const articleResponseSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  status: z.enum(ARTICLE_STATUSES),
  attachments: z.array(z.strictObject({ file_id: z.uuid(), name: z.string(), content_type: z.string() })),
  created_by: z.strictObject({ id: z.uuid(), name: z.string() }),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ArticleResponse = z.infer<typeof articleResponseSchema>;

export const articleListItemSchema = articleResponseSchema.pick({ id: true, title: true, tags: true, status: true, updated_at: true });
export type ArticleListItem = z.infer<typeof articleListItemSchema>;
export const articleListResponseSchema = pageSchema(articleListItemSchema);
