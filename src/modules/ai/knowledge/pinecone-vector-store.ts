import { Pinecone } from '@pinecone-database/pinecone';
import type { Passage, VectorStore } from './vector-store';

/** Pinecone upserts at most this many records a call. */
const BATCH = 96;

/**
 * Pinecone with integrated embedding (AI 1 spec, goal 15): an index created for an embedding model
 * whose field map embeds `text`. Never called by a test: they use `FakeVectorStore`.
 */
export class PineconeVectorStore implements VectorStore {
  private readonly client: Pinecone;

  constructor(
    apiKey: string,
    private readonly indexName: string,
  ) {
    this.client = new Pinecone({ apiKey });
  }

  private index(namespace: string) {
    return this.client.index(this.indexName).namespace(namespace);
  }

  async replaceArticle(namespace: string, articleId: string, passages: Passage[]): Promise<void> {
    const index = this.index(namespace);
    // Passages of an earlier, longer version would otherwise survive.
    await index.deleteMany({ filter: { articleId: { $eq: articleId } } });
    for (let start = 0; start < passages.length; start += BATCH) {
      await index.upsertRecords({
        records: passages.slice(start, start + BATCH).map((passage) => ({
          _id: passage.id,
          text: passage.text,
          articleId: passage.articleId,
          title: passage.title,
        })),
      });
    }
  }

  async search(namespace: string, query: string, topK: number): Promise<(Passage & { score: number })[]> {
    const response = await this.index(namespace).searchRecords({
      query: { topK, inputs: { text: query } },
      fields: ['text', 'articleId', 'title'],
    });
    return response.result.hits.map((hit) => {
      const fields = hit.fields as { text?: unknown; articleId?: unknown; title?: unknown };
      return {
        id: hit._id,
        articleId: String(fields.articleId ?? ''),
        title: String(fields.title ?? ''),
        text: String(fields.text ?? ''),
        score: hit._score,
      };
    });
  }

  async dropNamespace(namespace: string): Promise<void> {
    await this.index(namespace).deleteAll();
  }
}
