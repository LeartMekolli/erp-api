/**
 * The one HTML frame every email is sent in (plan N1). Templates only ever
 * supply escaped paragraphs; this can move to MJML later without touching
 * a template.
 */
export function emailLayout(escapedTitle: string, bodyHtml: string): string {
  return (
    '<!doctype html>' +
    '<html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapedTitle}</title></head>` +
    '<body style="margin:0;padding:24px;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#222;">' +
    '<div style="max-width:560px;margin:0 auto;padding:24px;background:#fff;border-radius:6px;line-height:1.5;">' +
    bodyHtml +
    '</div></body></html>'
  );
}
