import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import {
  addVersionResponseSchema,
  downloadUrlResponseSchema,
  fileDetailResponseSchema,
  fileResponseSchema,
  startUploadResponseSchema,
  versionResponseSchema,
} from '../src/modules/files/file-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { cube, stl } from './stl';
import { putToSignedUrl } from './storage';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

const PASSWORD = 'a-long-customer-password';

interface Upload {
  url: string;
  headers: Record<string, string>;
}

interface Started {
  file: { id: string; owner: { type: string; id: string } | null };
  version: { id: string };
  upload: Upload;
}

type Client = ReturnType<typeof clientFor>;

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return {
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
  };
}

describe('portal: customers upload and keep their own files', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];
  const design = stl(cube(10), 'binary');

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
    worker = await startTestWorker();
  });

  afterAll(async () => {
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
    await app?.close();
  });

  /** Anna owns Luna; Ben is a buyer at Luna and a viewer at Sol. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const staffUser = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, staffUser.id)).accessToken);
    const customer = async (name: string) => ((await staff.post('/customers', { name }).expect(201)).body as { id: string }).id;
    const luna = await customer('Luna Jewels');
    const sol = await customer('Sol Rings');

    async function join(customerId: string, email: string, role: string, name?: string) {
      await staff.post(`/customers/${customerId}/invitations`, { email, role }).expect(201);
      const token = notifier.lastCustomerInvitationFor(email)!.token;
      await request(app.getHttpServer())
        .post('/auth/customer-invitations/accept')
        .send(name ? { token, name, password: PASSWORD } : { token })
        .expect(204);
    }
    const person = async (email: string) => {
      const user = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email } }));
      return clientFor(app, (await tokens.issueForUser(tenant.id, user.id)).accessToken);
    };
    const anna = `anna-${newId()}@portal.example.test`;
    const ben = `ben-${newId()}@portal.example.test`;
    await join(luna, anna, 'owner', 'Anna');
    await join(luna, ben, 'buyer', 'Ben');
    await join(sol, ben, 'viewer');

    return { tenantId: tenant.id, staff, luna, sol, anna: await person(anna), ben: await person(ben) };
  }

  const files = (customerId: string, rest = '') => `/portal/customers/${customerId}/files${rest}`;
  const designUpload = { kind: 'design', name: 'ring.stl', content_type: 'model/stl', size: design.length, declared_unit: 'mm' };

  async function upload(started: Started): Promise<void> {
    const put = await putToSignedUrl(started.upload.url, design, started.upload.headers);
    await put.arrayBuffer();
    expect(put.status).toBe(200);
  }

  const untilMeasured = (tenantId: string, versionId: string) =>
    waitFor(async () => {
      const row = await prisma.inTenant(tenantId, (tx) => tx.fileVersion.findUniqueOrThrow({ where: { id: versionId } }));
      return row.status === 'measured' ? row : undefined;
    });

  it('lets a buyer upload a design file that everyone at the customer sees, measured', async () => {
    const w = await workspace();

    const started = await w.ben.post(files(w.luna), designUpload).expect(201);
    expectDocumented(startUploadResponseSchema, started.body);
    const { file, version } = started.body as Started;
    expect(file.owner).toEqual({ type: 'customer', id: w.luna });
    await upload(started.body as Started);
    const completed = await w.ben.post(files(w.luna, `/${file.id}/versions/${version.id}/complete`)).expect(200);
    expectDocumented(versionResponseSchema, completed.body);
    await untilMeasured(w.tenantId, version.id);

    const seen = await w.anna.get(files(w.luna, `/${file.id}`)).expect(200);
    expectDocumented(fileDetailResponseSchema, seen.body);
    const measures = (seen.body as { versions: { measures: { type: string; value: string }[] }[] }).versions[0].measures;
    expect(measures).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'volume', value: '1000' })]));

    const listed = await w.anna.get(files(w.luna)).expect(200);
    expectDocumented(pageSchema(fileResponseSchema), listed.body);
    expect((listed.body as { data: { id: string }[] }).data.map((entry) => entry.id)).toEqual([file.id]);

    const link = await w.anna.get(files(w.luna, `/${file.id}/versions/${version.id}/url`)).expect(200);
    expectDocumented(downloadUrlResponseSchema, link.body);

    const next = await w.ben
      .post(files(w.luna, `/${file.id}/versions`), { name: 'ring-v2.stl', content_type: 'model/stl', size: design.length })
      .expect(201);
    expectDocumented(addVersionResponseSchema, next.body);

    // Staff still see the customer's file.
    await w.staff.get(`/files/${file.id}`).expect(200);
  });

  it("keeps a customer's files to its own people, and to people who may upload", async () => {
    const w = await workspace();
    const lunaFile = (await w.ben.post(files(w.luna), designUpload).expect(201)).body as Started;
    const staffFile = (await w.staff.post('/files', designUpload).expect(201)).body as Started;

    // Ben is only a viewer at Sol.
    await w.ben.post(files(w.sol), designUpload).expect(403);
    await w.ben.get(files(w.sol)).expect(200);

    // Luna's file under Sol's path, and a staff file under Luna's path, are not found.
    for (const path of [
      files(w.sol, `/${lunaFile.file.id}`),
      files(w.sol, `/${lunaFile.file.id}/versions/${lunaFile.version.id}/url`),
      files(w.luna, `/${staffFile.file.id}`),
    ]) {
      const response = await w.ben.get(path);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
    await w.anna.post(files(w.luna, `/${staffFile.file.id}/versions/${staffFile.version.id}/complete`)).expect(404);
    await w.anna
      .post(files(w.luna, `/${staffFile.file.id}/versions`), { name: 'x.stl', content_type: 'model/stl', size: 10 })
      .expect(404);
    expect(((await w.ben.get(files(w.sol)).expect(200)).body as { data: unknown[] }).data).toEqual([]);
    expect(((await w.ben.get(files(w.luna)).expect(200)).body as { data: { id: string }[] }).data.map((f) => f.id)).toEqual([
      lunaFile.file.id,
    ]);
  });

  it('lets staff upload a file for a customer, which its people then see', async () => {
    const w = await workspace();
    const other = await workspace();

    const started = await w.staff.post('/files', { ...designUpload, customer_id: w.luna }).expect(201);
    const { file } = started.body as Started;
    expect(file.owner).toEqual({ type: 'customer', id: w.luna });
    await w.anna.get(files(w.luna, `/${file.id}`)).expect(200);

    await w.staff.post('/files', { ...designUpload, customer_id: other.luna }).expect(404);
    await w.staff.post('/files', { ...designUpload, customer_id: newId() }).expect(404);
  });
});
