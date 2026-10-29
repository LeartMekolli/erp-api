import type { Passage } from './vector-store';

/** The longest passage; whole paragraphs are joined up to it. */
export const MAX_PASSAGE_CHARS = 1_000;
const SEPARATOR = '\n\n';

/** A paragraph longer than a passage, cut at spaces. */
function cut(paragraph: string): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > MAX_PASSAGE_CHARS) {
    const space = rest.lastIndexOf(' ', MAX_PASSAGE_CHARS);
    const at = space > 0 ? space : MAX_PASSAGE_CHARS;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * The article's body, then each attachment's text, as passages of whole paragraphs joined up to about
 * 1,000 characters. Ids are `<articleId>:<n>`, numbered from 0.
 */
export function toPassages(article: { id: string; title: string; body: string }, attachments: string[]): Passage[] {
  const paragraphs = [article.body, ...attachments]
    .flatMap((text) => text.split(/\n\s*\n/))
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .flatMap(cut);

  const texts: string[] = [];
  for (const paragraph of paragraphs) {
    const last = texts.at(-1);
    if (last !== undefined && last.length + SEPARATOR.length + paragraph.length <= MAX_PASSAGE_CHARS) {
      texts[texts.length - 1] = `${last}${SEPARATOR}${paragraph}`;
    } else {
      texts.push(paragraph);
    }
  }
  return texts.map((text, n) => ({ id: `${article.id}:${n}`, articleId: article.id, title: article.title, text }));
}
