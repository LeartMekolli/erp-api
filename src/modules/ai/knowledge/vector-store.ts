/** A piece of an article's text, searched by meaning. */
export interface Passage {
  /** `<articleId>:<n>`. */
  id: string;
  articleId: string;
  title: string;
  text: string;
}

/**
 * Where knowledge passages are searched (AI 1 spec, goal 15): Pinecone, or a fake. Postgres holds the
 * articles; this is derived from them and can be rebuilt. One namespace per workspace, always built with
 * `namespaceOf` from a tenant id in code, never from a request.
 */
export interface VectorStore {
  /** Replaces every passage of the article; `[]` removes it. */
  replaceArticle(namespace: string, articleId: string, passages: Passage[]): Promise<void>;
  search(namespace: string, query: string, topK: number): Promise<(Passage & { score: number })[]>;
  dropNamespace(namespace: string): Promise<void>;
}

export const VECTOR_STORE = Symbol('VECTOR_STORE');

export const namespaceOf = (tenantId: string): string => `ws_${tenantId}`;
