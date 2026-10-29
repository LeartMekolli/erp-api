import { MAX_PASSAGE_CHARS, toPassages } from './passages';

const ARTICLE = '01900000-0000-7000-8000-0000000000a1';

/** A paragraph of exactly `length` characters, starting with its number. */
const paragraph = (n: number, length = 490) => `Paragraph ${n}. `.padEnd(length, 'x');

describe('toPassages', () => {
  it('joins whole paragraphs into passages of about 1,000 characters, numbered', () => {
    const body = [1, 2, 3, 4, 5].map((n) => paragraph(n)).join('\n\n');

    const passages = toPassages({ id: ARTICLE, title: 'Casting QC', body }, []);

    expect(passages.map((passage) => passage.id)).toEqual([`${ARTICLE}:0`, `${ARTICLE}:1`, `${ARTICLE}:2`]);
    expect(passages.map((passage) => passage.text)).toEqual([
      `${paragraph(1)}\n\n${paragraph(2)}`,
      `${paragraph(3)}\n\n${paragraph(4)}`,
      paragraph(5),
    ]);
    for (const passage of passages) {
      expect(passage).toMatchObject({ articleId: ARTICLE, title: 'Casting QC' });
      expect(passage.text.length).toBeLessThanOrEqual(MAX_PASSAGE_CHARS);
    }
  });

  it("puts the attachments' text after the body", () => {
    const passages = toPassages({ id: ARTICLE, title: 'Casting QC', body: 'Check the sprue.' }, ['Weigh every piece.']);

    const text = passages.map((passage) => passage.text).join('\n\n');
    expect(text.indexOf('Check the sprue.')).toBeLessThan(text.indexOf('Weigh every piece.'));
  });

  it('splits a paragraph longer than a passage at a space, and drops empty ones', () => {
    const long = Array.from({ length: 300 }, (_, index) => `word${index}`).join(' ');

    const passages = toPassages({ id: ARTICLE, title: 'Long', body: `${long}\n\n\n\n   \n\n` }, ['']);

    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) {
      expect(passage.text.length).toBeLessThanOrEqual(MAX_PASSAGE_CHARS);
      expect(passage.text).toMatch(/^word\d+/);
      expect(passage.text).toMatch(/word\d+$/);
    }
    expect(passages.map((passage) => passage.text).join(' ')).toBe(long);
  });

  it('gives an article with no text no passages', () => {
    expect(toPassages({ id: ARTICLE, title: 'Empty', body: '  ' }, [])).toEqual([]);
  });
});
