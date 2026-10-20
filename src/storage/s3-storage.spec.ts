import { CopyObjectCommand, DeleteObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { createConfigService } from '../config/config.service';
import { ObjectChangedError, ObjectNotFoundError } from './object-storage';
import { contentDisposition, S3Storage } from './s3-storage';

/** The value inside `filename="…"`, the fallback every browser understands. */
function quotedName(header: string): string {
  const match = /filename="([^"]*)"/.exec(header);
  if (!match) {
    throw new Error(`no quoted filename in: ${header}`);
  }
  return match[1];
}

// Signing is computed locally: nothing here talks to storage.
const env = {
  DATABASE_URL: 'postgresql://a',
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

describe('S3Storage signed upload', () => {
  it('signs content-type and content-length only: no create-only header', async () => {
    const storage = new S3Storage(createConfigService({ ...env }));
    try {
      const put = await storage.presignPut('uploads/t/f/v', {
        contentType: 'text/plain',
        contentLength: 5,
        expiresInSeconds: 60,
      });

      expect(put.headers).toEqual({ 'content-type': 'text/plain', 'content-length': '5' });
      const signed = new URL(put.url).searchParams.get('X-Amz-SignedHeaders')?.split(';').sort();
      expect(signed).toEqual(['content-length', 'content-type', 'host']);
    } finally {
      storage.onModuleDestroy();
    }
  });
});

describe('S3Storage commands', () => {
  afterEach(() => jest.restoreAllMocks());

  /** Runs `use` against a storage whose client never leaves the process. */
  async function withStorage<T>(
    reply: unknown,
    use: (storage: S3Storage, sent: () => unknown[]) => Promise<T>,
  ): Promise<T> {
    const send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(() => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)) as never);
    const storage = new S3Storage(createConfigService({ ...env }));
    try {
      return await use(storage, () => send.mock.calls.map((call) => (call as unknown[])[0]));
    } finally {
      storage.onModuleDestroy();
      send.mockRestore();
    }
  }

  const failure = (status: number) =>
    new S3ServiceException({ name: 'Failure', $fault: 'client', $metadata: { httpStatusCode: status } });

  it('copy sends CopyObject from the source key to the destination, guarded by the source ETag', async () => {
    await withStorage({}, async (storage, sent) => {
      await storage.copy('uploads/t/f/v', 'files/t/f/v', { ifMatchEtag: '"abc"' });

      const [command] = sent();
      expect(command).toBeInstanceOf(CopyObjectCommand);
      expect((command as CopyObjectCommand).input).toMatchObject({
        Bucket: 'erp-files',
        Key: 'files/t/f/v',
        CopySource: 'erp-files/uploads/t/f/v',
        CopySourceIfMatch: '"abc"',
        MetadataDirective: 'COPY',
      });
    });
  });

  it('copy reports a changed source as ObjectChangedError and a missing one as ObjectNotFoundError', async () => {
    await withStorage(failure(412), async (storage) => {
      await expect(storage.copy('a', 'b', { ifMatchEtag: '"x"' })).rejects.toBeInstanceOf(ObjectChangedError);
    });
    await withStorage(failure(404), async (storage) => {
      await expect(storage.copy('a', 'b')).rejects.toBeInstanceOf(ObjectNotFoundError);
    });
    await withStorage(failure(500), async (storage) => {
      await expect(storage.copy('a', 'b')).rejects.toBeInstanceOf(S3ServiceException);
    });
  });

  it('delete sends DeleteObject for the key', async () => {
    await withStorage({}, async (storage, sent) => {
      await storage.delete('uploads/t/f/v');

      const [command] = sent();
      expect(command).toBeInstanceOf(DeleteObjectCommand);
      expect((command as DeleteObjectCommand).input).toMatchObject({ Bucket: 'erp-files', Key: 'uploads/t/f/v' });
    });
  });

  it('head returns size, type and ETag, and null for a 404', async () => {
    await withStorage({ ContentLength: 5, ContentType: 'text/plain', ETag: '"abc"' }, async (storage) => {
      expect(await storage.head('k')).toEqual({ size: 5, contentType: 'text/plain', etag: '"abc"' });
    });
    await withStorage(failure(404), async (storage) => {
      expect(await storage.head('k')).toBeNull();
    });
  });
});
