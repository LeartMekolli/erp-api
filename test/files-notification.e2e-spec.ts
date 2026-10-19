import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { MEASURERS, NoopMeasurer } from '../src/modules/files/measurers';
import type { Measurer } from '../src/modules/files/measurers';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { messagesTo, waitForMessage } from './mailpit';
import { putToSignedUrl } from './storage';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

/** PDFs measure as three pages; everything else falls to the no-op measurer. */
const pdfMeasurer: Measurer = {
  name: 'test-pdf',
  contentTypes: ['application/pdf'],
  measure: () => Promise.resolve([{ type: 'page_count', value: '3', unit: 'count' }]),
};

describe('files: the uploader is told when a file is measured', () => {
  // These tests wait for a real email through the worker and Mailpit.
  jest.setTimeout(15_000);

  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  interface Person {
    id: string;
    email: string;
    token: string;
  }

  async function freshTenant(): Promise<{ id: string; uploader: Person; otherOwner: Person; member: Person }> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const person = async (role: 'owner' | 'member'): Promise<Person> => {
      const user = await createTestUser(prisma, tenant.id, { roles: [role] });
      return { id: user.id, email: user.email, token: (await tokens.issueForUser(tenant.id, user.id)).accessToken };
    };
    return { id: tenant.id, uploader: await person('owner'), otherOwner: await person('owner'), member: await person('member') };
  }

  const http = () => request(app.getHttpServer());

  /** Starts an upload as `token` and PUTs the bytes; completing is left to the test. */
  async function uploaded(
    token: string,
    name: string,
    contentType: string,
  ): Promise<{ fileId: string; versionId: string }> {
    const body = Buffer.from(`test file ${newId()}`);
    const response = await http()
      .post('/files')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'document', name, content_type: contentType, size: body.length })
      .expect(201);
    const { file, version, upload } = response.body as {
      file: { id: string };
      version: { id: string };
      upload: { url: string; headers: Record<string, string> };
    };
    const put = await putToSignedUrl(upload.url, body, upload.headers);
    await put.arrayBuffer();
    expect(put.status).toBe(200);
    return { fileId: file.id, versionId: version.id };
  }

  const complete = (token: string, fileId: string, versionId: string) =>
    http().post(`/files/${fileId}/versions/${versionId}/complete`).set('Authorization', `Bearer ${token}`).expect(200);

  /** The file.measured notification about this version, once it has been dispatched. */
  const dispatchedNotification = (tenantId: string, versionId: string) =>
    waitFor(async () => {
      const notification = await prisma.inTenant(tenantId, (tx) =>
        tx.notification.findFirst({ where: { eventKey: 'file.measured', subjectId: versionId } }),
      );
      return notification?.status === 'dispatched' ? notification : undefined;
    }, 10_000);

  const feedOf = (tenantId: string, notificationId: string) =>
    prisma.inTenant(tenantId, (tx) => tx.notificationRecipient.findMany({ where: { notificationId } }));

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);

    worker = await startTestWorker((builder) =>
      builder.overrideProvider(MEASURERS).useValue([pdfMeasurer, new NoopMeasurer()]),
    );
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app?.close();
  });

  it('reaches the uploader by email and in the feed', async () => {
    const tenant = await freshTenant();
    const pdf = await uploaded(tenant.uploader.token, 'report.pdf', 'application/pdf');

    await complete(tenant.uploader.token, pdf.fileId, pdf.versionId);

    const message = await waitForMessage(tenant.uploader.email);
    expect(message.subject).toBe('report.pdf is ready');
    expect(message.text).toContain('Your file report.pdf has been checked and measured.');
    expect(message.text).toContain('Measures: page_count: 3 count');

    const notification = await dispatchedNotification(tenant.id, pdf.versionId);
    expect(notification.subjectType).toBe('file_version');
    const feed = await feedOf(tenant.id, notification.id);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ userId: tenant.uploader.id, title: 'report.pdf is ready' });
    expect(feed[0].body).toContain('Measures: page_count: 3 count');
  });

  it('says so when the type has no measures', async () => {
    const tenant = await freshTenant();
    const text = await uploaded(tenant.uploader.token, 'notes.txt', 'text/plain');

    await complete(tenant.uploader.token, text.fileId, text.versionId);

    const message = await waitForMessage(tenant.uploader.email);
    expect(message.subject).toBe('notes.txt is ready');
    expect(message.text).toContain('Measures: no measures for this type');
  });

  it("uses the tenant's override", async () => {
    const tenant = await freshTenant();
    await http()
      .put('/notification-templates/file.measured/en')
      .set('Authorization', `Bearer ${tenant.uploader.token}`)
      .send({ subject: 'Checked: {{ file_name }}', body: 'All set. {{ measures }}', enabled: true })
      .expect(200);
    const pdf = await uploaded(tenant.uploader.token, 'poster.pdf', 'application/pdf');

    await complete(tenant.uploader.token, pdf.fileId, pdf.versionId);

    const message = await waitForMessage(tenant.uploader.email);
    expect(message.subject).toBe('Checked: poster.pdf');
    expect(message.text).toContain('All set. page_count: 3 count');
  });

  it('sends nothing to a deactivated uploader, and nothing to anyone else', async () => {
    const tenant = await freshTenant();
    const pdf = await uploaded(tenant.uploader.token, 'report.pdf', 'application/pdf');
    await prisma.inTenant(tenant.id, (tx) =>
      tx.user.update({ where: { id: tenant.uploader.id }, data: { status: 'deactivated' } }),
    );

    // Another owner completes it; the notice still belongs to the uploader alone.
    await complete(tenant.otherOwner.token, pdf.fileId, pdf.versionId);

    const notification = await dispatchedNotification(tenant.id, pdf.versionId);
    expect(await feedOf(tenant.id, notification.id)).toEqual([]);
    expect(await messagesTo(tenant.uploader.email)).toHaveLength(0);
    expect(await messagesTo(tenant.otherOwner.email)).toHaveLength(0);
    expect(await messagesTo(tenant.member.email)).toHaveLength(0);
    const version = await prisma.inTenant(tenant.id, (tx) =>
      tx.fileVersion.findUniqueOrThrow({ where: { id: pdf.versionId } }),
    );
    expect(version.status).toBe('measured');
  });
});
