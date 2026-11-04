import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
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
import { measuredDesign } from './catalog-fixtures';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { putToSignedUrl } from './storage';

interface Started {
  file: { id: string; kind: string; owner: { type: string; id: string } | null };
  version: { id: string };
  upload: { url: string; headers: Record<string, string> };
}

/** Not a real image: storage checks only the declared size and type. */
const PHOTO_BYTES = Buffer.from('a QC photo of the pieces');

/**
 * Partners upload the QC photos their moves need, as files they own: only images, seen only by the
 * partner's own people and by staff.
 */
describe('partner portal: files the partner owns', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
  });

  beforeAll(async () => {
    // Its own queues: no other suite's worker takes this one's measuring jobs.
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  /** CastCo and MetalWorks, each with a member; Luna, a customer with a file of its own; and a staff file. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const partner = async (name: string) =>
      ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
    const castco = await partner('CastCo');
    const metalworks = await partner('MetalWorks');
    const member = async (partnerId: string) => {
      const user = await createTestUser(prisma, tenant.id, { roles: [] });
      await prisma.inTenant(tenant.id, async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { kind: 'partner' } });
        await tx.organisationMembership.create({
          data: { userId: user.id, organisationType: 'partner', organisationId: partnerId, role: 'member' },
        });
      });
      return as((await tokens.issueForUser(tenant.id, user.id)).accessToken);
    };
    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;

    return {
      id: tenant.id,
      staff,
      castco,
      metalworks,
      castcoPerson: await member(castco),
      metalworksPerson: await member(metalworks),
      customerFile: await measuredDesign(prisma, tenant.id, owner.id, { customerId: luna }),
      staffFile: await measuredDesign(prisma, tenant.id, owner.id),
    };
  }

  const files = (partnerId: string, rest = '') => `/partner-portal/partners/${partnerId}/files${rest}`;
  const photo = { name: 'qc.jpg', content_type: 'image/jpeg', size: PHOTO_BYTES.length };

  it('lets a partner member upload a photo that its people and staff see', async () => {
    const w = await workspace();

    const started = await w.castcoPerson.post(files(w.castco), photo).expect(201);
    expectDocumented(startUploadResponseSchema, started.body);
    const { file, version, upload } = started.body as Started;
    expect(file).toMatchObject({ kind: 'image', owner: { type: 'partner', id: w.castco } });

    const put = await putToSignedUrl(upload.url, PHOTO_BYTES, upload.headers);
    await put.arrayBuffer();
    expect(put.status).toBe(200);
    const completed = await w.castcoPerson.post(files(w.castco, `/${file.id}/versions/${version.id}/complete`)).expect(200);
    expectDocumented(versionResponseSchema, completed.body);

    const seen = await w.castcoPerson.get(files(w.castco, `/${file.id}`)).expect(200);
    expectDocumented(fileDetailResponseSchema, seen.body);
    const listed = await w.castcoPerson.get(files(w.castco)).expect(200);
    expectDocumented(pageSchema(fileResponseSchema), listed.body);
    expect((listed.body as { data: { id: string }[] }).data.map((entry) => entry.id)).toEqual([file.id]);
    const link = await w.castcoPerson.get(files(w.castco, `/${file.id}/versions/${version.id}/url`)).expect(200);
    expectDocumented(downloadUrlResponseSchema, link.body);

    const next = await w.castcoPerson.post(files(w.castco, `/${file.id}/versions`), { ...photo, name: 'qc-2.png', content_type: 'image/png' });
    expect(next.status).toBe(201);
    expectDocumented(addVersionResponseSchema, next.body);

    // Staff see the partner's file through the files routes.
    await w.staff.get(`/files/${file.id}`).expect(200);
    await w.staff.get(`/files/${file.id}/versions/${version.id}/url`).expect(200);
  });

  it('takes only images', async () => {
    const w = await workspace();

    for (const body of [
      { ...photo, content_type: 'model/stl' },
      { ...photo, content_type: 'application/pdf' },
      { ...photo, content_type: 'image/svg+xml' },
    ]) {
      const response = await w.castcoPerson.post(files(w.castco), body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    const { file } = (await w.castcoPerson.post(files(w.castco), { ...photo, kind: 'design' }).expect(201)).body as Started;
    // Whatever kind is sent, a partner's file is an image.
    expect(file.kind).toBe('image');
    await w.castcoPerson.post(files(w.castco, `/${file.id}/versions`), { ...photo, content_type: 'model/stl' }).expect(400);
  });

  it("keeps a partner to its own files: never another partner's, a customer's or the workspace's", async () => {
    const w = await workspace();
    const castcoFile = (await w.castcoPerson.post(files(w.castco), photo).expect(201)).body as Started;

    // MetalWorks can't reach CastCo's routes at all.
    await w.metalworksPerson.get(files(w.castco)).expect(404);
    await w.metalworksPerson.post(files(w.castco), photo).expect(404);

    // Under its own path, another owner's file is not found.
    const others = [
      { fileId: castcoFile.file.id, versionId: castcoFile.version.id },
      { fileId: w.customerFile.fileId, versionId: w.customerFile.versionId },
      { fileId: w.staffFile.fileId, versionId: w.staffFile.versionId },
    ];
    for (const { fileId, versionId } of others) {
      for (const path of [`/${fileId}`, `/${fileId}/versions/${versionId}/url`]) {
        const response = await w.metalworksPerson.get(files(w.metalworks, path));
        expect({ path, status: response.status }).toEqual({ path, status: 404 });
      }
      const completed = await w.metalworksPerson.post(files(w.metalworks, `/${fileId}/versions/${versionId}/complete`));
      expect({ fileId, status: completed.status }).toEqual({ fileId, status: 404 });
      const added = await w.metalworksPerson.post(files(w.metalworks, `/${fileId}/versions`), photo);
      expect({ fileId, status: added.status }).toEqual({ fileId, status: 404 });
    }
    expect(((await w.metalworksPerson.get(files(w.metalworks)).expect(200)).body as { data: unknown[] }).data).toEqual([]);
  });
});
