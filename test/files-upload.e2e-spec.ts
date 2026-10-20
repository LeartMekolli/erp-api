import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { ConfigService } from '../src/config/config.service';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { uploadKeyFor } from '../src/modules/files/storage-keys';
import { ObjectStorage, STORAGE } from '../src/storage/object-storage';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { putToSignedUrl } from './storage';

interface VersionBody {
  id: string;
  number: number;
  original_name: string;
  content_type: string;
  size: number;
  checksum: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
}

interface FileBody {
  id: string;
  kind: string;
  name: string;
  declared_unit: string | null;
  owner: { type: string; id: string } | null;
  status: string;
  created_at: string;
}

interface Upload {
  url: string;
  method: string;
  headers: Record<string, string>;
  expires_at: string;
}

describe('files: starting uploads', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let storage: ObjectStorage;
  let maxBytes: number;
  const createdTenants: string[] = [];

  async function freshTenant(): Promise<{ id: string; ownerToken: string; memberToken: string }> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    return {
      id: tenant.id,
      ownerToken: (await tokens.issueForUser(tenant.id, owner.id)).accessToken,
      memberToken: (await tokens.issueForUser(tenant.id, member.id)).accessToken,
    };
  }

  const pdf = Buffer.from('%PDF-1.7 a small test document');

  const startUpload = (token: string, body: object) =>
    request(app.getHttpServer()).post('/files').set('Authorization', `Bearer ${token}`).send(body);
  const addVersion = (token: string, fileId: string, body: object) =>
    request(app.getHttpServer()).post(`/files/${fileId}/versions`).set('Authorization', `Bearer ${token}`).send(body);
  const getFile = (token: string, fileId: string) =>
    request(app.getHttpServer()).get(`/files/${fileId}`).set('Authorization', `Bearer ${token}`);

  const validFile = { kind: 'document', name: 'report.pdf', content_type: 'application/pdf', size: pdf.length };
  const validVersion = { name: 'report-v2.pdf', content_type: 'application/pdf', size: pdf.length };

  async function created(token: string): Promise<{ file: FileBody; version: VersionBody; upload: Upload }> {
    const response = await startUpload(token, validFile).expect(201);
    return response.body as { file: FileBody; version: VersionBody; upload: Upload };
  }

  const storedKey = async (tenantId: string, versionId: string) =>
    (await prisma.inTenant(tenantId, (tx) => tx.fileVersion.findUniqueOrThrow({ where: { id: versionId } })))
      .storageKey;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    storage = moduleRef.get<ObjectStorage>(STORAGE);
    maxBytes = moduleRef.get(ConfigService).get('FILE_MAX_BYTES');
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('starts an upload: a pending version 1 and a signed URL that accepts exactly the declared bytes', async () => {
    const tenant = await freshTenant();
    const before = Date.now();

    const { file, version, upload } = await created(tenant.ownerToken);

    expect(file).toEqual({
      id: expect.any(String),
      kind: 'document',
      name: 'report.pdf',
      declared_unit: null,
      owner: null,
      status: 'active',
      created_at: expect.any(String),
    });
    expect(version).toEqual({
      id: expect.any(String),
      number: 1,
      original_name: 'report.pdf',
      content_type: 'application/pdf',
      size: pdf.length,
      checksum: null,
      status: 'pending',
      created_at: expect.any(String),
      completed_at: null,
    });
    expect(upload.method).toBe('PUT');
    expect(upload.headers).toEqual({
      'content-type': 'application/pdf',
      'content-length': String(pdf.length),
    });
    const expiresAt = Date.parse(upload.expires_at);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 15 * 60_000 - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1000);

    const put = await putToSignedUrl(upload.url, pdf, upload.headers);
    await put.arrayBuffer();
    expect(put.status).toBe(200);
    // Nothing at the final key until complete copies it there.
    expect(await storage.head(await storedKey(tenant.id, version.id))).toBeNull();
    expect(await storage.head(uploadKeyFor(await storedKey(tenant.id, version.id)))).toEqual({
      size: pdf.length,
      contentType: 'application/pdf',
      etag: expect.any(String),
    });
    // No "412 on a second PUT" any more: the checked bytes are protected by the
    // copy made on completion, not by the link.
  });

  it('builds the storage key from ids, whatever the name', async () => {
    const tenant = await freshTenant();

    const response = await startUpload(tenant.ownerToken, { ...validFile, name: '../../etc/passwd' }).expect(201);
    const { file, version, upload } = response.body as { file: FileBody; version: VersionBody; upload: Upload };

    expect(file.name).toBe('../../etc/passwd');
    expect(await storedKey(tenant.id, version.id)).toBe(`files/${tenant.id}/${file.id}/${version.id}`);
    expect(new URL(upload.url).pathname).toContain(`uploads/${tenant.id}/${file.id}/${version.id}`);
    expect(new URL(upload.url).pathname).not.toContain('passwd');
  });

  it('stores the content type lowercased and asks the client to send it so', async () => {
    const tenant = await freshTenant();

    const response = await startUpload(tenant.ownerToken, { ...validFile, content_type: 'Application/PDF' }).expect(201);
    const { version, upload } = response.body as { version: VersionBody; upload: Upload };

    expect(version.content_type).toBe('application/pdf');
    expect(upload.headers['content-type']).toBe('application/pdf');
    const put = await putToSignedUrl(upload.url, pdf, upload.headers);
    await put.arrayBuffer();
    expect(put.status).toBe(200);
  });

  it('numbers a second version 2, with its own upload URL', async () => {
    const tenant = await freshTenant();
    const { file, upload: first } = await created(tenant.ownerToken);

    const response = await addVersion(tenant.ownerToken, file.id, validVersion).expect(201);
    const { version, upload } = response.body as { version: VersionBody; upload: Upload };

    expect(version).toMatchObject({ number: 2, original_name: 'report-v2.pdf', status: 'pending' });
    expect(upload.url).not.toBe(first.url);
    expect(await storedKey(tenant.id, version.id)).toBe(`files/${tenant.id}/${file.id}/${version.id}`);
  });

  it('numbers two versions started at once 2 and 3', async () => {
    const tenant = await freshTenant();
    const { file } = await created(tenant.ownerToken);

    const responses = await Promise.all([
      addVersion(tenant.ownerToken, file.id, validVersion),
      addVersion(tenant.ownerToken, file.id, validVersion),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const numbers = responses.map((response) => (response.body as { version: VersionBody }).version.number);
    expect(numbers.sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('refuses a bad size, kind, content type, unit or name with 400', async () => {
    const tenant = await freshTenant();
    const { file } = await created(tenant.ownerToken);

    const badFiles = [
      { ...validFile, size: 0 },
      { ...validFile, size: maxBytes + 1 },
      { ...validFile, size: 1.5 },
      { ...validFile, kind: 'spreadsheet' },
      { ...validFile, content_type: 'pdf' },
      { ...validFile, content_type: 'application/pdf\r\nx-evil: 1' },
      { ...validFile, declared_unit: 'ft' },
      { ...validFile, name: '   ' },
      { ...validFile, name: 'a'.repeat(256) },
    ];
    for (const body of badFiles) {
      const response = await startUpload(tenant.ownerToken, body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }

    const badVersions = [
      { ...validVersion, size: 0 },
      { ...validVersion, content_type: 'text' },
      { ...validVersion, name: '' },
    ];
    for (const body of badVersions) {
      const response = await addVersion(tenant.ownerToken, file.id, body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
  });

  it('shows a file with its versions newest first and their measures', async () => {
    const tenant = await freshTenant();
    const { file, version: first } = await created(tenant.ownerToken);
    const second = ((await addVersion(tenant.ownerToken, file.id, validVersion).expect(201)).body as {
      version: VersionBody;
    }).version;
    // Measuring arrives with Task 4; a measure written directly stands in for it.
    await prisma.inTenant(tenant.id, (tx) =>
      tx.measure.create({ data: { fileVersionId: first.id, type: 'width', value: '210.5', unit: 'mm' } }),
    );

    const response = await getFile(tenant.memberToken, file.id).expect(200);
    const body = response.body as FileBody & { versions: (VersionBody & { measures: object[] })[] };

    expect(body).toMatchObject({ id: file.id, kind: 'document', name: 'report.pdf', owner: null });
    expect(body.versions.map((version) => version.id)).toEqual([second.id, first.id]);
    expect(body.versions[0].measures).toEqual([]);
    expect(body.versions[1].measures).toEqual([{ type: 'width', value: '210.5', unit: 'mm' }]);
  });

  it('lets a member read but not upload', async () => {
    const tenant = await freshTenant();
    const { file } = await created(tenant.ownerToken);

    await getFile(tenant.memberToken, file.id).expect(200);
    await startUpload(tenant.memberToken, validFile).expect(403);
    await addVersion(tenant.memberToken, file.id, validVersion).expect(403);
  });

  it("gives 404 for another tenant's file, on reading and on new versions", async () => {
    const tenantA = await freshTenant();
    const tenantB = await freshTenant();
    const { file } = await created(tenantA.ownerToken);

    await getFile(tenantB.ownerToken, file.id).expect(404);
    await addVersion(tenantB.ownerToken, file.id, validVersion).expect(404);
    await getFile(tenantA.ownerToken, newId()).expect(404);

    const versions = await prisma.inTenant(tenantA.id, (tx) => tx.fileVersion.count({ where: { fileId: file.id } }));
    expect(versions).toBe(1);
  });
});
