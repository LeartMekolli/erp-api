/**
 * `text` as LIKE and ILIKE read it literally: Prisma's `contains` and a raw `LIKE` both pass `%`, `_` and
 * `\` through as wildcards and the escape, so a search for `%` would match everything.
 */
export function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
