import { FakeVectorStore } from './fake-vector-store';
import { namespaceOf } from './vector-store';
import type { Passage } from './vector-store';

const A = namespaceOf('01900000-0000-7000-8000-0000000000aa');
const B = namespaceOf('01900000-0000-7000-8000-0000000000bb');

const passage = (articleId: string, n: number, text: string): Passage => ({ id: `${articleId}:${n}`, articleId, title: articleId, text });

describe('FakeVectorStore', () => {
  it('names a namespace from the workspace id', () => {
    expect(A).toBe('ws_01900000-0000-7000-8000-0000000000aa');
  });

  it('finds the passage sharing the most words first, ignoring case, and none sharing nothing', async () => {
    const store = new FakeVectorStore();
    await store.replaceArticle(A, 'qc', [passage('qc', 0, 'A failed casting QC goes back to casting.'), passage('qc', 1, 'Polish after casting.')]);
    await store.replaceArticle(A, 'packing', [passage('packing', 0, 'Pack every piece in tissue.')]);

    const found = await store.search(A, 'What happens after a FAILED casting qc?', 5);

    expect(found.map((one) => one.id)).toEqual(['qc:0', 'qc:1']);
    expect(found[0].score).toBeGreaterThan(found[1].score);
  });

  it('returns at most topK passages', async () => {
    const store = new FakeVectorStore();
    await store.replaceArticle(A, 'qc', [0, 1, 2].map((n) => passage('qc', n, 'casting')));

    expect(await store.search(A, 'casting', 2)).toHaveLength(2);
  });

  it("replaces an article's passages, and removes them when given none", async () => {
    const store = new FakeVectorStore();
    await store.replaceArticle(A, 'qc', [passage('qc', 0, 'old casting text'), passage('qc', 1, 'more casting')]);
    await store.replaceArticle(A, 'qc', [passage('qc', 0, 'new casting text')]);

    expect(store.passagesOf(A, 'qc').map((one) => one.text)).toEqual(['new casting text']);

    await store.replaceArticle(A, 'qc', []);
    expect(store.passagesOf(A, 'qc')).toEqual([]);
    expect(await store.search(A, 'casting', 5)).toEqual([]);
  });

  it('never mixes namespaces, and drops a whole one', async () => {
    const store = new FakeVectorStore();
    await store.replaceArticle(A, 'qc', [passage('qc', 0, 'casting')]);

    expect(await store.search(B, 'casting', 5)).toEqual([]);

    await store.dropNamespace(A);
    expect(await store.search(A, 'casting', 5)).toEqual([]);
  });
});
