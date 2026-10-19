import { contentDisposition } from './s3-storage';

/** The value inside `filename="…"`, the fallback every browser understands. */
function quotedName(header: string): string {
  const match = /filename="([^"]*)"/.exec(header);
  if (!match) {
    throw new Error(`no quoted filename in: ${header}`);
  }
  return match[1];
}

describe('contentDisposition', () => {
  it('keeps plain names', () => {
    expect(contentDisposition('report.pdf', 'application/pdf')).toBe(
      `inline; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('downloads anything outside the inline list', () => {
    expect(contentDisposition('logo.svg', 'image/svg+xml')).toMatch(/^attachment;/);
    expect(contentDisposition('page.html', 'text/html')).toMatch(/^attachment;/);
  });

  it('neutralises quotes, newlines and paths', () => {
    const header = contentDisposition('a"b\r\nX-Evil: 1/../c.txt', 'text/plain');

    expect(header).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''\S+$/);
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).not.toContain('/');
    expect(header).not.toContain('\\');
    expect(quotedName(header)).not.toContain('"');
  });

  it('encodes non-ASCII in filename*', () => {
    const header = contentDisposition('résumé.pdf', 'application/pdf');

    expect(header).toContain(`filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`);
    expect(quotedName(header)).toMatch(/^[\x20-\x7e]+\.pdf$/);
  });
});
