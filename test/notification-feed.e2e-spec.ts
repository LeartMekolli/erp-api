import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { hashPassword } from '../src/modules/identity/passwords';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

interface FeedEntry {
  id: string;
  event_key: string;
  subject: { type: string; id: string };
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

interface FeedPage {
  data: FeedEntry[];
  next_cursor: string | null;
}

describe('notification feed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  let adminId: string;

  async function freshUser(tenantId?: string): Promise<{ tenantId: string; userId: string; token: string }> {
    let id = tenantId;
    if (!id) {
      id = (await createTestTenant(prisma)).id;
      createdTenants.push(id);
    }
    const user = await createTestUser(prisma, id);
    return { tenantId: id, userId: user.id, token: (await tokens.issueForUser(id, user.id)).accessToken };
  }

  /** A feed entry as dispatch writes it (Task 8 covers dispatch itself). */
  async function feedEntry(tenantId: string, userId: string, title: string): Promise<string> {
    return prisma.inTenant(tenantId, async (tx) => {
      const notification = await tx.notification.create({
        data: {
          eventKey: 'user.roles_changed',
          audience: 'user',
          subjectType: 'user',
          subjectId: userId,
          payload: { user_name: 'Feed', roles: 'member' },
          status: 'dispatched',
        },
      });
      const entry = await tx.notificationRecipient.create({
        data: { notificationId: notification.id, userId, title, body: `${title} body` },
      });
      return entry.id;
    });
  }

  const feed = (token: string, query = '') =>
    request(app.getHttpServer()).get(`/notifications${query}`).set('Authorization', `Bearer ${token}`);
  const markRead = (token: string, id: string) =>
    request(app.getHttpServer()).post(`/notifications/${id}/read`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    if (adminId) {
      await prisma.platformAdmin.delete({ where: { id: adminId } });
    }
    await app.close();
  });

  it('lists my notifications newest first with a cursor', async () => {
    const me = await freshUser();
    const first = await feedEntry(me.tenantId, me.userId, 'First');
    const second = await feedEntry(me.tenantId, me.userId, 'Second');
    const third = await feedEntry(me.tenantId, me.userId, 'Third');

    const page = (await feed(me.token, '?limit=2').expect(200)).body as FeedPage;
    expect(page.data.map((entry) => entry.id)).toEqual([third, second]);
    expect(page.data[0]).toEqual({
      id: third,
      event_key: 'user.roles_changed',
      subject: { type: 'user', id: me.userId },
      title: 'Third',
      body: 'Third body',
      created_at: expect.any(String),
      read_at: null,
    });
    expect(page.next_cursor).not.toBeNull();

    const rest = (await feed(me.token, `?limit=2&cursor=${page.next_cursor}`).expect(200)).body as FeedPage;
    expect(rest.data.map((entry) => entry.id)).toEqual([first]);
    expect(rest.next_cursor).toBeNull();
  });

  it('unread=true hides read ones', async () => {
    const me = await freshUser();
    const read = await feedEntry(me.tenantId, me.userId, 'Read');
    const unread = await feedEntry(me.tenantId, me.userId, 'Unread');
    await markRead(me.token, read).expect(204);

    const page = (await feed(me.token, '?unread=true').expect(200)).body as FeedPage;
    expect(page.data.map((entry) => entry.id)).toEqual([unread]);

    const all = (await feed(me.token).expect(200)).body as FeedPage;
    expect(all.data.find((entry) => entry.id === read)?.read_at).toEqual(expect.any(String));
  });

  it('marking read is idempotent: the first read time is kept', async () => {
    const me = await freshUser();
    const id = await feedEntry(me.tenantId, me.userId, 'Twice');

    await markRead(me.token, id).expect(204);
    const firstReadAt = ((await feed(me.token).expect(200)).body as FeedPage).data[0]?.read_at;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await markRead(me.token, id).expect(204);
    const secondReadAt = ((await feed(me.token).expect(200)).body as FeedPage).data[0]?.read_at;

    expect(firstReadAt).toEqual(expect.any(String));
    expect(secondReadAt).toBe(firstReadAt);
  });

  it("another user's notification gives 404, in my tenant and in another", async () => {
    const me = await freshUser();
    const colleague = await freshUser(me.tenantId);
    const stranger = await freshUser();
    const colleagues = await feedEntry(me.tenantId, colleague.userId, 'Colleague');
    const strangers = await feedEntry(stranger.tenantId, stranger.userId, 'Stranger');

    await markRead(me.token, colleagues).expect(404);
    await markRead(me.token, strangers).expect(404);
    expect(((await feed(me.token).expect(200)).body as FeedPage).data).toEqual([]);

    // Nothing changed for them.
    const theirs = ((await feed(colleague.token).expect(200)).body as FeedPage).data;
    expect(theirs.map((entry) => [entry.id, entry.read_at])).toEqual([[colleagues, null]]);
  });

  it('rejects a malformed id with 400', async () => {
    const me = await freshUser();
    await markRead(me.token, 'not-a-uuid').expect(400);
  });

  it('a platform token gets 403', async () => {
    const admin = await prisma.platformAdmin.create({
      data: { email: `feed-${newId()}@example.test`, passwordHash: await hashPassword('platform-admin-password'), name: 'Feed Admin' },
    });
    adminId = admin.id;
    const token = (await tokens.issueForPlatformAdmin(admin.id)).accessToken;

    await feed(token).expect(403);
    await markRead(token, newId()).expect(403);
  });
});
