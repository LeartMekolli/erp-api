import { Test, TestingModule } from '@nestjs/testing';
import { newId } from '../src/common/ids/uuid';
import { ConfigModule } from '../src/config/config.module';
import { ConfigService } from '../src/config/config.service';
import { ObjectChangedError, ObjectNotFoundError, ObjectStorage, STORAGE } from '../src/storage/object-storage';
import { StorageModule } from '../src/storage/storage.module';
import { putToSignedUrl } from './storage';

describe('object storage', () => {
  let moduleRef: TestingModule;
  let storage: ObjectStorage;
  let config: ConfigService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [ConfigModule, StorageModule] }).compile();
    storage = moduleRef.get<ObjectStorage>(STORAGE);
    config = moduleRef.get(ConfigService);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  const newKey = () => `e2e/${newId()}/${newId()}`;

  /** Signs a PUT for exactly these bytes and type, and uploads them with the headers storage asks for. */
  async function store(key: string, body: Buffer, contentType: string): Promise<void> {
    const signed = await storage.presignPut(key, {
      contentType,
      contentLength: body.length,
      expiresInSeconds: 60,
    });
    const response = await putToSignedUrl(signed.url, body, signed.headers);
    await response.arrayBuffer();
    expect(response.status).toBe(200);
  }

  it('a signed PUT stores exactly the declared bytes, and HEAD reports them', async () => {
    const key = newKey();

    await store(key, Buffer.from('hello'), 'text/plain');

    expect(await storage.head(key)).toEqual({ size: 5, contentType: 'text/plain', etag: expect.any(String) });
  });

  it('a PUT asks for exactly the signed type and length', async () => {
    const signed = await storage.presignPut(newKey(), {
      contentType: 'text/plain',
      contentLength: 5,
      expiresInSeconds: 60,
    });

    expect(signed.headers).toEqual({ 'content-type': 'text/plain', 'content-length': '5' });
  });

  it('the same link can write again until it expires: write-once comes from copy-on-completion, not storage', async () => {
    const key = newKey();
    const signed = await storage.presignPut(key, {
      contentType: 'text/plain',
      contentLength: 5,
      expiresInSeconds: 60,
    });
    for (const body of ['hello', 'HELLO']) {
      const response = await putToSignedUrl(signed.url, Buffer.from(body), signed.headers);
      await response.arrayBuffer();
      expect(response.status).toBe(200);
    }
  });

  it('copy duplicates the object server-side, keeps the source, and keeps the content type', async () => {
    const from = newKey();
    const to = newKey();
    await store(from, Buffer.from('hello'), 'text/plain');
    const source = await storage.head(from);

    await storage.copy(from, to, { ifMatchEtag: source?.etag });

    expect(await storage.head(to)).toEqual({ size: 5, contentType: 'text/plain', etag: expect.any(String) });
    expect(await storage.head(from)).not.toBeNull();
  });

  it('copy is refused when the source is no longer the object that was checked', async () => {
    const from = newKey();
    await store(from, Buffer.from('hello'), 'text/plain');
    const checked = await storage.head(from);
    await store(from, Buffer.from('HELLO'), 'text/plain');
    const to = newKey();

    await expect(storage.copy(from, to, { ifMatchEtag: checked?.etag })).rejects.toBeInstanceOf(ObjectChangedError);
    expect(await storage.head(to)).toBeNull();
  });

  it('copy of a missing key is ObjectNotFoundError', async () => {
    await expect(storage.copy(newKey(), newKey())).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('delete removes an object, and deleting a missing key is not an error', async () => {
    const key = newKey();
    await store(key, Buffer.from('hello'), 'text/plain');

    await storage.delete(key);
    await storage.delete(key);

    expect(await storage.head(key)).toBeNull();
  });

  it('a PUT with more bytes than signed is refused', async () => {
    const key = newKey();
    const signed = await storage.presignPut(key, {
      contentType: 'text/plain',
      contentLength: 5,
      expiresInSeconds: 60,
    });

    const response = await putToSignedUrl(signed.url, Buffer.from('hello!'), signed.headers);
    await response.arrayBuffer();

    expect(response.status).toBe(403);
    expect(await storage.head(key)).toBeNull();
  });

  it('a PUT with another content type than signed is refused', async () => {
    const key = newKey();
    const signed = await storage.presignPut(key, {
      contentType: 'image/png',
      contentLength: 5,
      expiresInSeconds: 60,
    });

    const response = await putToSignedUrl(signed.url, Buffer.from('hello'), {
      ...signed.headers,
      'content-type': 'text/html',
    });
    await response.arrayBuffer();

    expect(response.status).toBe(403);
    expect(await storage.head(key)).toBeNull();
  });

  it('head is null for a missing key', async () => {
    expect(await storage.head(newKey())).toBeNull();
  });

  it('a signed GET of a PDF opens inline, of anything else downloads', async () => {
    const pdfKey = newKey();
    const htmlKey = newKey();
    await store(pdfKey, Buffer.from('%PDF-1.7'), 'application/pdf');
    await store(htmlKey, Buffer.from('<script>alert(1)</script>'), 'text/html');

    const pdf = await fetch(
      await storage.presignGet(pdfKey, {
        fileName: 'report.pdf',
        contentType: 'application/pdf',
        expiresInSeconds: 60,
      }),
    );
    const html = await fetch(
      await storage.presignGet(htmlKey, {
        fileName: 'page.html',
        contentType: 'text/html',
        expiresInSeconds: 60,
      }),
    );

    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await pdf.arrayBuffer()).toString()).toBe('%PDF-1.7');

    expect(html.status).toBe(200);
    expect(html.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(html.headers.get('content-type')).toBe('text/html');
    await html.arrayBuffer();
  });

  it('read streams the object back', async () => {
    const key = newKey();
    const body = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 256));
    await store(key, body, 'application/octet-stream');

    const chunks: Buffer[] = [];
    for await (const chunk of await storage.read(key)) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }

    expect(Buffer.concat(chunks).equals(body)).toBe(true);
  });

  it('the bucket is not public', async () => {
    const key = newKey();
    await store(key, Buffer.from('secret'), 'text/plain');

    // Path-style address, as MinIO serves it locally and in CI.
    const unsigned = await fetch(`${config.get('S3_ENDPOINT')}/${config.get('S3_BUCKET')}/${key}`);
    await unsigned.arrayBuffer();

    expect(unsigned.status).toBe(403);
  });
});
