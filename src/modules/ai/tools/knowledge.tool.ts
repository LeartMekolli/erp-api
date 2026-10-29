import { z } from 'zod';
import type { PrismaService } from '../../../database/prisma.service';
import { namespaceOf } from '../knowledge/vector-store';
import type { VectorStore } from '../knowledge/vector-store';
import type { AiTool } from './tool';

/** How many passages an ask is given. */
export const KNOWLEDGE_TOP_K = 6;

/**
 * The knowledge base, for every staff user: the passages closest to the query, in the asking user's own
 * workspace only. A passage of an article no longer published is left out.
 */
export function knowledgeTools(prisma: PrismaService, store: VectorStore): AiTool<unknown>[] {
  const searchKnowledge: AiTool<{ query: string }> = {
    name: 'search_knowledge',
    description: "Search the workspace's knowledge base (how things are done: procedures, FAQs) for passages about the query.",
    permissions: [],
    input: z.strictObject({ query: z.string().min(1).max(300) }),
    run: async (ctx, input) => {
      const found = await store.search(namespaceOf(ctx.tenantId), input.query, KNOWLEDGE_TOP_K);
      const published = await prisma.inTenant(ctx.tenantId, (tx) =>
        tx.knowledgeArticle.findMany({ where: { id: { in: [...new Set(found.map((one) => one.articleId))] }, status: 'published' }, select: { id: true } }),
      );
      const live = new Set(published.map((row) => row.id));
      const passages = found.filter((one) => live.has(one.articleId));
      return {
        data: passages.map((one) => ({ article_id: one.articleId, title: one.title, text: one.text })),
        refs: [...live].filter((id) => passages.some((one) => one.articleId === id)).map((id) => ({ type: 'article' as const, id })),
      };
    },
  };
  return [searchKnowledge] as AiTool<unknown>[];
}
