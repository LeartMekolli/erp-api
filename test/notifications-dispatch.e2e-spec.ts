import { createHash, randomBytes } from 'node:crypto';
import { TestingModule } from '@nestjs/testing';
import { newId } from '../src/common/ids/uuid';
import { createConfigService } from '../src/config/config.service';
import { PrismaService } from '../src/database/prisma.service';
import { LOG_DESTINATION } from '../src/common/logging/logging.module';
import { ERROR_REPORTER } from '../src/common/reporting/reporting.module';
import { ClaimSweeper } from '../src/jobs/claim-sweeper';
import { JobsService } from '../src/jobs/jobs.service';
import { JOB_REGISTRY, JOBS, JobRegistry, SCHEDULED_JOBS } from '../src/jobs/registry';
import { DispatchHandler } from '../src/modules/notifications/dispatch.handler';
import { MAILER, Mailer, SmtpMailer } from '../src/modules/notifications/mailer';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { TemplatesService } from '../src/modules/notifications/templates.service';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { messagesTo, waitForMessage } from './mailpit';
import { waitFor } from './wait-for';
import { startTestWorker } from './worker-harness';

/** The real jobs and attempt counts, with tiny backoffs so retries finish within a test. */
const fixture: JobRegistry = {
  jobs: {
    ...JOBS,
    'notification.dispatch': { ...JOBS['notification.dispatch'], backoffMs: 10 },
    'notification.email': { ...JOBS['notification.email'], backoffMs: 1 },
  },
  scheduled: SCHEDULED_JOBS,
};

/** Delegates to Mailpit, or fails every send with `failure` while `failing` is set. */
const mail = { failing: false, failure: (): Error => new Error('smtp is down') };

const emailJobId = (notificationId: string, to: string) =>
  `notification.email/${notificationId}/${createHash('sha256').update(to).digest('hex').slice(0, 16)}`;

describe('notification dispatch', () => {
  let worker: TestingModule;
  let prisma: PrismaService;
  let notifications: NotificationsService;
  let jobs: JobsService;
  const createdTenants: string[] = [];
  const lines: string[] = [];
  const reporter = { report: jest.fn() };

  async function freshTenant(): Promise<string> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    return tenant.id;
  }

  const notificationRow = (tenantId: string, id: string) =>
    prisma.inTenant(tenantId, (tx) => tx.notification.findUniqueOrThrow({ where: { id } }));

  const deliveries = (tenantId: string, notificationId: string) =>
    prisma.inTenant(tenantId, (tx) =>
      tx.notificationDelivery.findMany({ where: { notificationId }, orderBy: { createdAt: 'asc' } }),
    );

  const untilDispatched = (tenantId: string, id: string) =>
    waitFor(async () => ((await notificationRow(tenantId, id)).status === 'dispatched' ? true : undefined));

  const untilSent = (tenantId: string, id: string, count = 1) =>
    waitFor(async () =>
      (await deliveries(tenantId, id)).filter((row) => row.status === 'sent').length >= count ? true : undefined,
    );

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const real = new SmtpMailer(createConfigService());
    const switchable: Mailer = {
      send: (message) => (mail.failing ? Promise.reject(mail.failure()) : real.send(message)),
    };

    worker = await startTestWorker((builder) =>
      builder
        .overrideProvider(JOB_REGISTRY)
        .useValue(fixture)
        .overrideProvider(MAILER)
        .useValue(switchable)
        .overrideProvider(LOG_DESTINATION)
        .useValue({ write: (line: string) => lines.push(line) })
        .overrideProvider(ERROR_REPORTER)
        .useValue(reporter),
    );
    prisma = worker.get(PrismaService);
    notifications = worker.get(NotificationsService, { strict: false });
    jobs = worker.get(JobsService);
  });

  afterAll(async () => {
    await jobs?.queue('notifications').obliterate({ force: true });
    await worker?.close();
    await deleteTestTenants(prisma, createdTenants);
  });

  afterEach(() => {
    mail.failing = false;
    mail.failure = () => new Error('smtp is down');
    reporter.report.mockClear();
    jest.restoreAllMocks();
  });

  it('a user event reaches Mailpit and the feed', async () => {
    const tenantId = await freshTenant();
    const user = await createTestUser(prisma, tenantId);

    const id = await notifications.raise(tenantId, 'user.roles_changed', { type: 'user', id: user.id }, {
      user_name: 'Ada',
      roles: 'owner, member',
    });

    const message = await waitForMessage(user.email);
    expect(message.subject).toBe('Your roles have changed');
    expect(message.text).toContain('Your roles are now: owner, member.');
    expect(message.from.address).toBe('no-reply@example.test');

    await untilSent(tenantId, id);
    await untilDispatched(tenantId, id);
    const feed = await prisma.inTenant(tenantId, (tx) => tx.notificationRecipient.findMany({ where: { notificationId: id } }));
    expect(feed).toEqual([
      expect.objectContaining({ userId: user.id, title: 'Your roles have changed', readAt: null }),
    ]);
    expect(feed[0]?.body).toContain('Your roles are now: owner, member.');
    expect(await deliveries(tenantId, id)).toEqual([
      expect.objectContaining({ channel: 'email', target: user.email, status: 'sent', attempt: 1 }),
    ]);
  });

  it("uses the tenant's override and sender", async () => {
    const tenantId = await freshTenant();
    const user = await createTestUser(prisma, tenantId);
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.notificationTemplate.create({
        data: {
          eventKey: 'user.roles_changed',
          locale: 'en',
          subject: 'Access update for {{ user_name }}',
          body: 'You now hold: {{ roles }}',
        },
      });
      await tx.tenantSetting.create({
        data: { key: 'notification.sender', value: { name: 'Acme Print', email: 'hello@acme.example' } },
      });
    });

    await notifications.raise(tenantId, 'user.roles_changed', { type: 'user', id: user.id }, {
      user_name: 'Grace',
      roles: 'member',
    });

    const message = await waitForMessage(user.email);
    expect(message.subject).toBe('Access update for Grace');
    expect(message.text).toBe('You now hold: member');
    expect(message.from).toEqual({ name: 'Acme Print', address: 'hello@acme.example' });
  });

  it('a permission audience includes staff recipients from settings, without duplicates', async () => {
    const tenantId = await freshTenant();
    const owner = await createTestUser(prisma, tenantId, { roles: ['owner'] });
    const deactivated = await createTestUser(prisma, tenantId, { roles: ['owner'], status: 'deactivated' });
    const member = await createTestUser(prisma, tenantId, { roles: ['member'] });
    const extra = `ops-${newId()}@example.test`;
    await prisma.inTenant(tenantId, (tx) =>
      tx.tenantSetting.create({
        // The owner is listed again: they must still get one email.
        data: { key: 'notification.staffRecipients', value: { byEvent: { 'user.joined': [extra, owner.email] } } },
      }),
    );

    const id = await notifications.raise(tenantId, 'user.joined', { type: 'user', id: member.id }, {
      user_name: 'New Person',
      user_email: member.email,
    });

    await untilSent(tenantId, id, 2);
    await untilDispatched(tenantId, id);
    expect((await deliveries(tenantId, id)).map((row) => row.target).sort()).toEqual([extra, owner.email].sort());
    expect(await messagesTo(owner.email)).toHaveLength(1);
    expect(await messagesTo(extra)).toHaveLength(1);
    expect(await messagesTo(deactivated.email)).toHaveLength(0);
    expect(await messagesTo(member.email)).toHaveLength(0);

    // Only users get a feed entry; the extra address is email-only.
    const feed = await prisma.inTenant(tenantId, (tx) => tx.notificationRecipient.findMany({ where: { notificationId: id } }));
    expect(feed.map((row) => row.userId)).toEqual([owner.id]);
  });

  it('a dispatch that fails halfway is retried, not skipped', async () => {
    const tenantId = await freshTenant();
    const user = await createTestUser(prisma, tenantId);
    const templates = worker.get(TemplatesService, { strict: false });
    // The first render, while dispatch writes the feed, blows up.
    jest.spyOn(templates, 'forRecipient').mockRejectedValueOnce(new Error('boom'));

    const id = await notifications.raise(tenantId, 'user.roles_changed', { type: 'user', id: user.id }, {
      user_name: 'Retry',
      roles: 'member',
    });

    await untilDispatched(tenantId, id);
    const feed = await prisma.inTenant(tenantId, (tx) => tx.notificationRecipient.count({ where: { notificationId: id } }));
    expect(feed).toBe(1);
    await waitForMessage(user.email);
  });

  it('a failing mailer records failed attempts, then dead-letters and marks nothing sent', async () => {
    const tenantId = await freshTenant();
    const user = await createTestUser(prisma, tenantId);
    mail.failing = true;

    const id = await notifications.raise(tenantId, 'user.roles_changed', { type: 'user', id: user.id }, {
      user_name: 'Down',
      roles: 'member',
    });

    const queue = jobs.queue('notifications');
    await waitFor(async () =>
      (await (await queue.getJob(emailJobId(id, user.email)))?.getState()) === 'failed' ? true : undefined,
    );

    const attempts = JOBS['notification.email'].attempts;
    const rows = await deliveries(tenantId, id);
    expect(rows).toHaveLength(attempts);
    expect(rows.every((row) => row.status === 'failed' && row.error === 'smtp is down')).toBe(true);
    expect(rows.map((row) => row.attempt)).toEqual(Array.from({ length: attempts }, (_, index) => index + 1));
    expect(await messagesTo(user.email)).toHaveLength(0);
  });

  it("a mail server's rejection reaches the delivery log, but never an address into logs or error reports", async () => {
    const tenantId = await freshTenant();
    const user = await createTestUser(prisma, tenantId);
    mail.failing = true;
    mail.failure = () =>
      Object.assign(new Error(`550 5.1.1 <${user.email}>: Recipient address rejected`), { responseCode: 550 });

    const id = await notifications.raise(tenantId, 'user.roles_changed', { type: 'user', id: user.id }, {
      user_name: 'Rejected',
      roles: 'member',
    });
    await waitFor(async () =>
      (await (await jobs.queue('notifications').getJob(emailJobId(id, user.email)))?.getState()) === 'failed'
        ? true
        : undefined,
    );

    // The delivery log keeps the provider's answer; it already holds the address as its target.
    expect((await deliveries(tenantId, id))[0]?.error).toContain('550 5.1.1');

    // Logs and error reports carry the status code only (spec 1.4: no personal data in logs).
    expect(lines.join('\n')).not.toContain(user.email);
    expect(lines.some((line) => line.includes('550'))).toBe(true);
    const reported = reporter.report.mock.calls.map(([error]) => String((error as Error).message));
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.join('\n')).not.toContain(user.email);
  });

  it('the sweeper recovers a notification whose dispatch job was dead-lettered while the database was down', async () => {
    const tenantId = await freshTenant();
    const user = await createTestUser(prisma, tenantId);
    const templates = worker.get(TemplatesService, { strict: false });
    const dispatch = worker.get(DispatchHandler, { strict: false });
    // Every attempt fails and hands its claim back; marking it failed fails too.
    const render = jest.spyOn(templates, 'forRecipient').mockRejectedValue(new Error('database is down'));
    const markFailed = jest.spyOn(dispatch, 'onDeadLetter').mockRejectedValue(new Error('database is down'));

    const id = await notifications.raise(tenantId, 'user.roles_changed', { type: 'user', id: user.id }, {
      user_name: 'Outage',
      roles: 'member',
    });
    const queue = jobs.queue('notifications');
    await waitFor(async () =>
      (await (await queue.getJob(`notification.dispatch/${id}`))?.getState()) === 'failed' ? true : undefined,
    );
    expect((await notificationRow(tenantId, id)).status).toBe('pending');

    // The database is back. A minute later the sweeper finds the pending row.
    render.mockRestore();
    markFailed.mockRestore();
    await prisma.inTenant(tenantId, (tx) =>
      tx.notification.update({ where: { id }, data: { createdAt: new Date(Date.now() - 2 * 60_000) } }),
    );
    await worker.get(ClaimSweeper).sweep();

    await untilDispatched(tenantId, id);
    expect((await waitForMessage(user.email)).subject).toBe('Your roles have changed');
  });

  it('a retried email is not sent twice once sent', async () => {
    const tenantId = await freshTenant();
    const user = await createTestUser(prisma, tenantId);
    const id = await notifications.raise(tenantId, 'user.roles_changed', { type: 'user', id: user.id }, {
      user_name: 'Once',
      roles: 'member',
    });
    await untilSent(tenantId, id);

    // The same email job again, as a retry after a crash would run it.
    await jobs.enqueue('notification.email', { tenantId, notificationId: id, to: user.email, locale: 'en', userId: user.id });
    await waitFor(async () => ((await jobs.queue('notifications').getJob(emailJobId(id, user.email))) ? undefined : true));

    expect(await messagesTo(user.email)).toHaveLength(1);
    expect((await deliveries(tenantId, id)).filter((row) => row.status === 'sent')).toHaveLength(1);
  });

  it('the sweeper requeues a notification whose enqueue was lost', async () => {
    const tenantId = await freshTenant();
    const user = await createTestUser(prisma, tenantId);
    // Raised two minutes ago, but its dispatch job never reached the queue.
    const lost = await prisma.inTenant(tenantId, (tx) =>
      tx.notification.create({
        data: {
          eventKey: 'user.roles_changed',
          audience: 'user',
          subjectType: 'user',
          subjectId: user.id,
          payload: { user_name: 'Lost', roles: 'member' },
          status: 'pending',
          createdAt: new Date(Date.now() - 2 * 60_000),
        },
      }),
    );

    await worker.get(ClaimSweeper).sweep();

    await untilDispatched(tenantId, lost.id);
    expect((await waitForMessage(user.email)).subject).toBe('Your roles have changed');
  });

  it('secrets are sealed at rest and wiped once sent', async () => {
    const tenantId = await freshTenant();
    const inviteeEmail = `invitee-${newId()}@example.test`;
    const marker = `marker-${newId()}`;
    const invitation = await prisma.inTenant(tenantId, async (tx) => {
      const role = await tx.role.findFirstOrThrow({ where: { name: 'member' } });
      return tx.invitation.create({
        data: {
          email: inviteeEmail,
          roleId: role.id,
          tokenHash: createHash('sha256').update(marker).digest('hex'),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    });

    const id = await notifications.raise(tenantId, 'user.invited', { type: 'invitation', id: invitation.id }, {
      tenant_name: 'Acme Print',
      link: `https://acme.example/accept-invitation#token=${marker}`,
    });

    // At rest: sealed. No column, read as text, carries the token.
    const [atRest] = await prisma.inTenant(tenantId, (tx) =>
      tx.$queryRaw<{ row: string }[]>`SELECT n::text AS row FROM notification n WHERE id = ${id}::uuid`,
    );
    expect(atRest?.row).not.toContain(marker);
    expect((await notificationRow(tenantId, id)).payload).toEqual({ tenant_name: 'Acme Print' });

    // Delivered: the email has the link, and the sealed copy is gone.
    const message = await waitForMessage(inviteeEmail);
    expect(message.text).toContain(`#token=${marker}`);
    expect(message.html).toContain(`href="https://acme.example/accept-invitation#token=${marker}"`);
    await waitFor(async () => ((await notificationRow(tenantId, id)).secrets === null ? true : undefined));

    const delivered = await deliveries(tenantId, id);
    expect(JSON.stringify(delivered)).not.toContain(marker);
    expect(await prisma.inTenant(tenantId, (tx) => tx.notificationRecipient.count({ where: { notificationId: id } }))).toBe(0);
  });
});
