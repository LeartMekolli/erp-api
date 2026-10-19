import { createConfigService } from '../config/config.service';
import { contentDisposition, S3Storage } from './s3-storage';

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

describe('S3Storage signing address', () => {
  // Signing is computed locally: nothing here talks to storage.
  const env = {
    DATABASE_URL: 'postgresql://a',
    DATABASE_MIGRATE_URL: 'postgresql://b',
    REDIS_URL: 'redis://c',
    APP_SECRET: 'a'.repeat(32),
    JWT_SECRET: 'j'.repeat(32),
    SMTP_URL: 'smtp://localhost:1025',
    MAIL_FROM: 'ERP <no-reply@example.test>',
    WEB_URL_TEMPLATE: 'http://{tenant}.localhost:5173',
    S3_ENDPOINT: 'http://minio:9000',
    S3_BUCKET: 'erp-files',
    S3_ACCESS_KEY_ID: 'minio',
    S3_SECRET_ACCESS_KEY: 'minio-password',
    S3_FORCE_PATH_STYLE: 'true',
  };

  async function signedHosts(extra: Record<string, string>): Promise<string[]> {
    const storage = new S3Storage(createConfigService({ ...env, ...extra }));
    try {
      const put = await storage.presignPut('t/f/v', { contentType: 'text/plain', contentLength: 5, expiresInSeconds: 60 });
      const get = await storage.presignGet('t/f/v', { fileName: 'a.txt', contentType: 'text/plain', expiresInSeconds: 60 });
      return [new URL(put.url).host, new URL(get).host];
    } finally {
      storage.onModuleDestroy();
    }
  }

  it('signs links for S3_PUBLIC_ENDPOINT when it is set', async () => {
    expect(await signedHosts({ S3_PUBLIC_ENDPOINT: 'http://localhost:9000' })).toEqual([
      'localhost:9000',
      'localhost:9000',
    ]);
  });

  it('signs links for S3_ENDPOINT otherwise', async () => {
    expect(await signedHosts({})).toEqual(['minio:9000', 'minio:9000']);
  });
});
