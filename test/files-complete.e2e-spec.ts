import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { ClaimSweeper } from '../src/jobs/claim-sweeper';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { MEASURERS, NoopMeasurer } from '../src/modules/files/measurers';
import type { Measurer, MeasureType, MeasureUnit } from '../src/modules/files/measurers';
import { ObjectStorage, STORAGE } from '../src/storage/object-storage';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { putToSignedUrl } from './storage';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

interface VersionBody {
  id: string;
  number: number;
  content_type: string;
  size: number;
  checksum: string | null;
  status: string;
  completed_at: string | null;
}

interface Upload {
  url: string;
  headers: Record<string, string>;
}

/** The real jobs, with a tiny backoff so a retry happens within the test. */
const fixture: JobRegistry = {
  jobs: { ...JOBS, 'file.measure': { ...JOBS['file.measure'], backoffMs: 10 } },
  scheduled: SCHEDULED_JOBS,
};

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString();
}

/**
 * Measures PDFs as three pages. Records every body it reads, so a test can
 * count how often its own upload was measured, and fails while `failuresLeft`
 * is above zero.
 */
const pdfMeasurer = {
  name: 'test-pdf',
  contentTypes: ['application/pdf'],
  failuresLeft: 0,
  bodies: [] as string[],
  async measure(input: {
    read: () => Promise<Readable>;
  }): Promise<{ type: MeasureType; value: string; unit: MeasureUnit }[]> {
    this.bodies.push(await readAll(await input.read()));
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error('measurer failed');
    }
    return [{ type: 'page_count', value: '3', unit: 'count' }];
  },
} satisfies Measurer & { failuresLeft: number; bodies: string[] };

describe('files: completing, measuring and downloading', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let storage: ObjectStorage;
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

  const http = () => request(app.getHttpServer());

  /** Starts an upload; with `send`, also PUTs the bytes. Bodies are unique per call. */
  async function startUpload(
    token: string,
    options: { name?: string; contentType?: string; send?: boolean } = {},
  ): Promise<{ fileId: string; version: VersionBody; upload: Upload; body: Buffer }> {
    const contentType = options.contentType ?? 'application/pdf';
    const body = Buffer.from(`%PDF-1.7 test ${newId()}`);
    const response = await http()
      .post('/files')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'document', name: options.name ?? 'report.pdf', content_type: contentType, size: body.length })
      .expect(201);
    const { file, version, upload } = response.body as { file: { id: string }; version: VersionBody; upload: Upload };

    if (options.send ?? true) {
      const put = await putToSignedUrl(upload.url, body, upload.headers);
      await put.arrayBuffer();
      expect(put.status).toBe(200);
    }
    return { fileId: file.id, version, upload, body };
  }

  const complete = (token: string, fileId: string, versionId: string) =>
    http().post(`/files/${fileId}/versions/${versionId}/complete`).set('Authorization', `Bearer ${token}`);
  const downloadUrl = (token: string, fileId: string, versionId: string) =>
    http().get(`/files/${fileId}/versions/${versionId}/url`).set('Authorization', `Bearer ${token}`);

  const versionRow = (tenantId: string, versionId: string) =>
    prisma.inTenant(tenantId, (tx) => tx.fileVersion.findUniqueOrThrow({ where: { id: versionId } }));

  const untilMeasured = (tenantId: string, versionId: string) =>
    waitFor(async () => {
      const row = await versionRow(tenantId, versionId);
      return row.status === 'measured' ? row : undefined;
    });

  const timesMeasured = (body: Buffer) => pdfMeasurer.bodies.filter((seen) => seen === body.toString()).length;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;

    // The API enqueues file.measure, and the backoff is fixed at enqueue time,
    // so the API needs the fixture registry as much as the worker does.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JOB_REGISTRY)
      .useValue(fixture)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    storage = moduleRef.get<ObjectStorage>(STORAGE);

    worker = await startTestWorker((builder) =>
      builder
        .overrideProvider(JOB_REGISTRY)
        .useValue(fixture)
        .overrideProvider(MEASURERS)
        .useValue([pdfMeasurer, new NoopMeasurer()]),
    );
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app?.close();
  });

  it('marks a completed upload uploaded, and the worker checksums and measures it', async () => {
    const tenant = await freshTenant();
    const { fileId, version, body } = await startUpload(tenant.ownerToken, {
      name: 'notes.txt',
      contentType: 'text/plain',
    });

    const response = await complete(tenant.ownerToken, fileId, version.id).expect(200);
    expect(response.body as VersionBody).toMatchObject({
      id: version.id,
      status: 'uploaded',
      completed_at: expect.any(String),
    });

    const measured = await untilMeasured(tenant.id, version.id);
    expect(measured.checksum).toBe(createHash('sha256').update(body).digest('hex'));
    expect(measured.claimedAt).toBeNull();
    const file = await http().get(`/files/${fileId}`).set('Authorization', `Bearer ${tenant.ownerToken}`).expect(200);
    expect((file.body as { versions: { measures: object[] }[] }).versions[0].measures).toEqual([]);
  });

  it("stores a registered measurer's values", async () => {
    const tenant = await freshTenant();
    const { fileId, version } = await startUpload(tenant.ownerToken);

    await complete(tenant.ownerToken, fileId, version.id).expect(200);
    await untilMeasured(tenant.id, version.id);

    const file = await http().get(`/files/${fileId}`).set('Authorization', `Bearer ${tenant.ownerToken}`).expect(200);
    const [latest] = (file.body as { versions: (VersionBody & { measures: object[] })[] }).versions;
    expect(latest.status).toBe('measured');
    expect(latest.measures).toEqual([{ type: 'page_count', value: '3', unit: 'count' }]);
  });

  it('refuses to complete before the upload, and leaves the version pending', async () => {
    const tenant = await freshTenant();
    const { fileId, version } = await startUpload(tenant.ownerToken, { send: false });

    const response = await complete(tenant.ownerToken, fileId, version.id).expect(409);

    expect((response.body as { detail: string }).detail).toBe('Upload not found');
    expect((await versionRow(tenant.id, version.id)).status).toBe('pending');
  });

  it('returns the same version when completed twice, and measures it once', async () => {
    const tenant = await freshTenant();
    const { fileId, version, body } = await startUpload(tenant.ownerToken);

    const first = await complete(tenant.ownerToken, fileId, version.id).expect(200);
    const second = await complete(tenant.ownerToken, fileId, version.id).expect(200);

    expect((second.body as VersionBody).id).toBe(version.id);
    expect((second.body as VersionBody).completed_at).toBe((first.body as VersionBody).completed_at);
    await untilMeasured(tenant.id, version.id);
    await complete(tenant.ownerToken, fileId, version.id).expect(200);
    expect(timesMeasured(body)).toBe(1);
  });

  it('refuses an object that differs from the declaration', async () => {
    const tenant = await freshTenant();
    const { fileId, version, body } = await startUpload(tenant.ownerToken, { send: false });
    const { storageKey } = await versionRow(tenant.id, version.id);
    // Bypasses the declared upload: a bigger object lands under the same key.
    const bigger = Buffer.concat([body, Buffer.from('!')]);
    const signed = await storage.presignPut(storageKey, {
      contentType: 'application/pdf',
      contentLength: bigger.length,
      expiresInSeconds: 60,
    });
    const put = await putToSignedUrl(signed.url, bigger, signed.headers);
    await put.arrayBuffer();
    expect(put.status).toBe(200);

    const response = await complete(tenant.ownerToken, fileId, version.id).expect(409);

    expect((response.body as { detail: string }).detail).toBe('Upload does not match what was declared');
    expect((await versionRow(tenant.id, version.id)).status).toBe('pending');
  });

  it('retries a measurer that fails, rather than skipping the version', async () => {
    const tenant = await freshTenant();
    const { fileId, version, body } = await startUpload(tenant.ownerToken);
    pdfMeasurer.failuresLeft = 1;

    await complete(tenant.ownerToken, fileId, version.id).expect(200);
    const measured = await untilMeasured(tenant.id, version.id);

    expect(timesMeasured(body)).toBe(2);
    expect(measured.checksum).toBe(createHash('sha256').update(body).digest('hex'));
    const measures = await prisma.inTenant(tenant.id, (tx) =>
      tx.measure.findMany({ where: { fileVersionId: version.id } }),
    );
    expect(measures.map((measure) => measure.type)).toEqual(['page_count']);
  });

  it('recovers a version stuck in measuring through the sweeper', async () => {
    const tenant = await freshTenant();
    const { version } = await startUpload(tenant.ownerToken);
    // As if a worker claimed it 11 minutes ago and died: no job is queued.
    const longAgo = new Date(Date.now() - 11 * 60_000);
    await prisma.inTenant(tenant.id, (tx) =>
      tx.fileVersion.update({
        where: { id: version.id },
        data: { status: 'measuring', claimedAt: longAgo, completedAt: longAgo },
      }),
    );

    await worker.get(ClaimSweeper).sweep();

    const measured = await untilMeasured(tenant.id, version.id);
    expect(measured.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs a 5-minute download: a PDF opens inline, an SVG downloads', async () => {
    const tenant = await freshTenant();
    const pdf = await startUpload(tenant.ownerToken);
    const svg = await startUpload(tenant.ownerToken, { name: 'logo.svg', contentType: 'image/svg+xml' });
    await complete(tenant.ownerToken, pdf.fileId, pdf.version.id).expect(200);
    await complete(tenant.ownerToken, svg.fileId, svg.version.id).expect(200);
    const before = Date.now();

    const pdfLink = (await downloadUrl(tenant.ownerToken, pdf.fileId, pdf.version.id).expect(200)).body as {
      url: string;
      expires_at: string;
    };
    const svgLink = (await downloadUrl(tenant.ownerToken, svg.fileId, svg.version.id).expect(200)).body as {
      url: string;
    };

    const expiresAt = Date.parse(pdfLink.expires_at);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1000);

    const pdfResponse = await fetch(pdfLink.url);
    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers.get('content-type')).toBe('application/pdf');
    expect(pdfResponse.headers.get('content-disposition')).toMatch(/^inline; filename="report\.pdf"/);
    expect(await pdfResponse.text()).toBe(pdf.body.toString());

    const svgResponse = await fetch(svgLink.url);
    await svgResponse.arrayBuffer();
    expect(svgResponse.headers.get('content-type')).toBe('image/svg+xml');
    expect(svgResponse.headers.get('content-disposition')).toMatch(/^attachment; filename="logo\.svg"/);
  });

  it('gives a hostile name a safe header', async () => {
    const tenant = await freshTenant();
    const { fileId, version } = await startUpload(tenant.ownerToken, { name: 'a"b\r\nc.pdf' });
    await complete(tenant.ownerToken, fileId, version.id).expect(200);

    const link = (await downloadUrl(tenant.ownerToken, fileId, version.id).expect(200)).body as { url: string };
    const response = await fetch(link.url);
    await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(/^inline; filename="[^"\r\n]*"; filename\*=UTF-8''\S+$/);
  });

  it('gives no download URL while the version is pending', async () => {
    const tenant = await freshTenant();
    const { fileId, version } = await startUpload(tenant.ownerToken);

    await downloadUrl(tenant.ownerToken, fileId, version.id).expect(409);
  });

  it("gives another tenant 404 on completing and on the download URL", async () => {
    const tenantA = await freshTenant();
    const tenantB = await freshTenant();
    const { fileId, version } = await startUpload(tenantA.ownerToken);

    await complete(tenantB.ownerToken, fileId, version.id).expect(404);
    await complete(tenantA.ownerToken, fileId, version.id).expect(200);
    await downloadUrl(tenantB.ownerToken, fileId, version.id).expect(404);
    // A real version under the wrong file is not found either.
    const other = await startUpload(tenantA.ownerToken);
    await downloadUrl(tenantA.ownerToken, other.fileId, version.id).expect(404);
  });

  it('lets a member download but not complete', async () => {
    const tenant = await freshTenant();
    const { fileId, version } = await startUpload(tenant.ownerToken);

    await complete(tenant.memberToken, fileId, version.id).expect(403);
    await complete(tenant.ownerToken, fileId, version.id).expect(200);
    await downloadUrl(tenant.memberToken, fileId, version.id).expect(200);
  });
});
