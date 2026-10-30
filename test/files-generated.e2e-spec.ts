import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { downloadUrlResponseSchema, fileDetailResponseSchema, fileResponseSchema } from '../src/modules/files/file-response';
import { FilesService } from '../src/modules/files/files.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { STORAGE } from '../src/storage/object-storage';
import type { ObjectStorage } from '../src/storage/object-storage';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'a-long-customer-password';
const IMAGE = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return { get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`) };
}

/** Files the server writes for a customer, such as an AI image, and removes again (AI 2 plan, Task 1). */
describe('files: written and removed by the server', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let files: FilesService;
  let storage: ObjectStorage;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_NOTIFIER)
      .useValue(notifier)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    files = moduleRef.get(FilesService);
    storage = moduleRef.get(STORAGE);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app?.close();
  });

  /** Anna owns Luna; Sam owns Sol. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const staffUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staffToken = (await tokens.issueForUser(tenant.id, staffUser.id)).accessToken;
    const staff = (path: string, body: object) =>
      request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${staffToken}`).send(body);
    const customer = async (name: string) => ((await staff('/customers', { name }).expect(201)).body as { id: string }).id;
    const owner = async (customerId: string, name: string) => {
      const email = `${name.toLowerCase()}-${newId()}@generated.example.test`;
      await staff(`/customers/${customerId}/invitations`, { email, role: 'owner' }).expect(201);
      await request(app.getHttpServer())
        .post('/auth/customer-invitations/accept')
        .send({ token: notifier.lastCustomerInvitationFor(email)!.token, name, password: PASSWORD })
        .expect(204);
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      return { id: user.id, client: clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken) };
    };
    const luna = await customer('Luna Jewels');
    const sol = await customer('Sol Rings');
    return { tenantId: tenant.id, luna, sol, anna: await owner(luna, 'Anna'), sam: await owner(sol, 'Sam') };
  }

  const path = (customerId: string, rest = '') => `/portal/customers/${customerId}/files${rest}`;

  it("stores a server-written image as the customer's file, once, and removes it again", async () => {
    const w = await workspace();
    const fileId = newId();
    const input = {
      fileId,
      owner: { type: 'customer' as const, id: w.luna },
      name: `ai-image-${fileId}.png`,
      bytes: IMAGE,
      contentType: 'image/png',
      createdByUserId: w.anna.id,
    };

    const stored = await files.storeGenerated(w.tenantId, input);
    expect(stored.fileId).toBe(fileId);

    const listed = await w.anna.client.get(path(w.luna)).expect(200);
    expectDocumented(pageSchema(fileResponseSchema), listed.body);
    expect((listed.body as { data: { id: string }[] }).data.map((file) => file.id)).toEqual([fileId]);
    const detail = await w.anna.client.get(path(w.luna, `/${fileId}`)).expect(200);
    expectDocumented(fileDetailResponseSchema, detail.body);
    expect(detail.body).toMatchObject({ kind: 'image', versions: [{ id: stored.versionId, status: 'measured', measures: [] }] });

    const link = await w.anna.client.get(path(w.luna, `/${fileId}/versions/${stored.versionId}/url`)).expect(200);
    expectDocumented(downloadUrlResponseSchema, link.body);
    const downloaded = await fetch((link.body as { url: string }).url);
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(IMAGE)).toBe(true);

    // Another customer never sees it.
    await w.sam.client.get(path(w.sol, `/${fileId}`)).expect(404);

    // A retried job writes nothing new.
    expect(await files.storeGenerated(w.tenantId, input)).toEqual(stored);
    expect(await prisma.inTenant(w.tenantId, (tx) => tx.fileVersion.count({ where: { fileId } }))).toBe(1);

    const key = (await prisma.inTenant(w.tenantId, (tx) => tx.fileVersion.findUniqueOrThrow({ where: { id: stored.versionId } })))
      .storageKey;
    await files.remove(w.tenantId, fileId, { type: 'customer', id: w.luna });

    await w.anna.client.get(path(w.luna, `/${fileId}`)).expect(404);
    await w.anna.client.get(path(w.luna, `/${fileId}/versions/${stored.versionId}/url`)).expect(404);
    expect(((await w.anna.client.get(path(w.luna)).expect(200)).body as { data: unknown[] }).data).toEqual([]);
    expect(await storage.head(key)).toBeNull();
    expect(
      (await prisma.inTenant(w.tenantId, (tx) => tx.file.findUniqueOrThrow({ where: { id: fileId } }))).status,
    ).toBe('removed');
  });

  it("refuses to remove another customer's file", async () => {
    const w = await workspace();
    const fileId = newId();
    await files.storeGenerated(w.tenantId, {
      fileId,
      owner: { type: 'customer', id: w.luna },
      name: 'ai-image.png',
      bytes: IMAGE,
      contentType: 'image/png',
      createdByUserId: w.anna.id,
    });

    await expect(files.remove(w.tenantId, fileId, { type: 'customer', id: w.sol })).rejects.toThrow('File not found');
    await w.anna.client.get(path(w.luna, `/${fileId}`)).expect(200);
  });
});
