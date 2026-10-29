import type { Passage, VectorStore } from './vector-store';

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** In memory, per namespace, for local work and tests: scored by the distinct words a passage shares with the query. */
export class FakeVectorStore implements VectorStore {
  private readonly namespaces = new Map<string, Map<string, Passage[]>>();

  replaceArticle(namespace: string, articleId: string, passages: Passage[]): Promise<void> {
    const articles = this.namespaces.get(namespace) ?? new Map<string, Passage[]>();
    if (passages.length === 0) articles.delete(articleId);
    else articles.set(articleId, passages.map((passage) => ({ ...passage })));
    this.namespaces.set(namespace, articles);
    return Promise.resolve();
  }

  search(namespace: string, query: string, topK: number): Promise<(Passage & { score: number })[]> {
    const wanted = words(query);
    const scored = [...(this.namespaces.get(namespace)?.values() ?? [])]
      .flat()
      .map((passage) => ({ ...passage, score: [...words(passage.text)].filter((word) => wanted.has(word)).length }))
      .filter((passage) => passage.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return Promise.resolve(scored.slice(0, topK));
  }

  dropNamespace(namespace: string): Promise<void> {
    this.namespaces.delete(namespace);
    return Promise.resolve();
  }

  /** What the store holds for an article, for tests. */
  passagesOf(namespace: string, articleId: string): Passage[] {
    return this.namespaces.get(namespace)?.get(articleId) ?? [];
  }
}
