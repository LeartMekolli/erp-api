import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { lockCustomer } from '../src/modules/customers/customers.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { CreditExpiryHandler } from '../src/modules/payments/credits/credit-expiry.handler';
import { creditBalanceResponseSchema, creditHistoryResponseSchema } from '../src/modules/payments/credits/credit-response';
import { CreditsService } from '../src/modules/payments/credits/credits.service';
import type { GrantSource } from '../src/modules/payments/credits/credit-ledger';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const PASSWORD = 'a-long-customer-password';
const DAY = 24 * 60 * 60 * 1000;

interface Balance {
  total: number;
  by_source: Record<GrantSource, number>;
  grants: { id: string; source: GrantSource; remaining: number; expires_at: string }[];
}

interface History {
  data: { kind: string; amount: number; source: GrantSource; reason: string | null; occurred_at: string }[];
  next_cursor: string | null;
}

function clientFor(app: INestApplication, token: string) {
  const http = () => request(app.getHttpServer());
  return {
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
  };
}

/** A date `days` from today, as `YYYY-MM-DD`. */
const dateIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

/** The credit ledger: grants, spends in a fixed order under the customer's lock, give-back and expiry (Payments 2 plan, Task 3). */
describe('payments: the credit ledger', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let credits: CreditsService;
  const notifier = new CapturingIdentityNotifier();
  const createdTenants: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_NOTIFIER)
      .useValue(notifier)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    credits = moduleRef.get(CreditsService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  /** Luna, owned by Anna, and Sol, with no credits; staff hold `credit.grant`, the member doesn't. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const staff = clientFor(app, (await tokens.issueForUser(tenant.id, owner.id)).accessToken);

    const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
    const sol = ((await staff.post('/customers', { name: 'Sol Studio' }).expect(201)).body as { id: string }).id;
    const annaEmail = `anna-${newId()}@credits.example.test`;
    await staff.post(`/customers/${luna}/invitations`, { email: annaEmail, role: 'owner' }).expect(201);
    await request(app.getHttpServer())
      .post('/auth/customer-invitations/accept')
      .send({ token: notifier.lastCustomerInvitationFor(annaEmail)!.token, name: 'Anna', password: PASSWORD })
      .expect(204);
    const annaUser = await prisma.inTenant(tenant.id, (tx) => tx.user.findFirstOrThrow({ where: { email: annaEmail } }));

    return {
      id: tenant.id,
      staff,
      member: clientFor(app, (await tokens.issueForUser(tenant.id, member.id)).accessToken),
      anna: clientFor(app, (await tokens.issueForUser(tenant.id, annaUser.id)).accessToken),
      luna,
      sol,
    };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  /** A grant written as the other modules write them: in a transaction holding the customer's lock. */
  const grant = (w: Workspace, input: { source: GrantSource; amount: number; expiresAt: Date; sourceKey: string; reason?: string }) =>
    prisma.inTenant(w.id, async (tx) => {
      await lockCustomer(tx, w.luna);
      return credits.grant(tx, { customerId: w.luna, ...input });
    });
  const balance = async (w: Workspace) => (await w.staff.get(`/payments/customers/${w.luna}/credits`).expect(200)).body as Balance;
  const spendCount = (w: Workspace) => prisma.inTenant(w.id, (tx) => tx.creditSpend.count({ where: { customerId: w.luna } }));

  it('grants staff credits with a reason, shown to staff and to the customer, and audited', async () => {
    const w = await workspace();
    const body = { amount: 30, expires_on: dateIn(90), reason: 'Sorry for the late delivery' };

    const granted = await w.staff.post(`/payments/customers/${w.luna}/credits`, body).expect(201);

    expectDocumented(creditBalanceResponseSchema, granted.body);
    expect(granted.body).toMatchObject({
      total: 30,
      by_source: { campaign: 0, staff: 30, allowance: 0, pack: 0 },
      grants: [{ source: 'staff', remaining: 30 }],
    });
    const staffHistory = await w.staff.get(`/payments/customers/${w.luna}/credits/history`).expect(200);
    expectDocumented(creditHistoryResponseSchema, staffHistory.body);
    expect((staffHistory.body as History).data).toEqual([
      expect.objectContaining({ kind: 'grant', amount: 30, source: 'staff', reason: 'Sorry for the late delivery' }),
    ]);

    // The customer reads its own, and nobody else's.
    const own = await w.anna.get(`/portal/customers/${w.luna}/credits`).expect(200);
    expectDocumented(creditBalanceResponseSchema, own.body);
    expect((own.body as Balance).total).toBe(30);
    const ownHistory = await w.anna.get(`/portal/customers/${w.luna}/credits/history`).expect(200);
    expectDocumented(creditHistoryResponseSchema, ownHistory.body);
    await w.anna.get(`/portal/customers/${w.sol}/credits`).expect(404);
    await w.anna.get(`/portal/customers/${w.sol}/credits/history`).expect(404);

    const entries = await prisma.inTenant(w.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'credits.granted', subjectId: w.luna } }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].after).toMatchObject({ amount: 30, reason: 'Sorry for the late delivery' });
  });

  it('refuses a grant without credit.grant, and one that is not whole, not ahead or has no reason', async () => {
    const w = await workspace();
    const body = { amount: 30, expires_on: dateIn(90), reason: 'Goodwill' };

    await w.member.post(`/payments/customers/${w.luna}/credits`, body).expect(403);
    await w.anna.post(`/payments/customers/${w.luna}/credits`, body).expect(403);
    for (const bad of [
      { ...body, amount: 0 },
      { ...body, amount: 2.5 },
      { ...body, expires_on: dateIn(-1) },
      { ...body, reason: '' },
      { amount: 30, expires_on: dateIn(90) },
    ]) {
      await w.staff.post(`/payments/customers/${w.luna}/credits`, bad).expect(400);
    }
    await w.staff.post(`/payments/customers/${newId()}/credits`, body).expect(404);
    expect((await balance(w)).total).toBe(0);
  });

  it('writes one grant for one source key, however often it is asked', async () => {
    const w = await workspace();
    const input = { source: 'campaign' as const, amount: 50, expiresAt: new Date(Date.now() + 60 * DAY), sourceKey: `campaign:${newId()}:${newId()}` };

    const first = await grant(w, input);
    const again = await grant(w, input);

    expect(first.created).toBe(true);
    expect(again).toEqual({ grantId: first.grantId, created: false });
    expect(await balance(w)).toMatchObject({ total: 50, by_source: { campaign: 50 } });
  });

  it('spends once per reference, refuses what the balance lacks, and gives back once', async () => {
    const w = await workspace();
    await w.staff.post(`/payments/customers/${w.luna}/credits`, { amount: 30, expires_on: dateIn(90), reason: 'Goodwill' }).expect(201);

    const spent = await credits.spend(w.id, w.luna, { amount: 12, reason: '3D generation', reference: 'job-1' });
    expect((await balance(w)).total).toBe(18);

    const again = await credits.spend(w.id, w.luna, { amount: 12, reason: '3D generation', reference: 'job-1' });
    expect(again.spendId).toBe(spent.spendId);
    expect((await balance(w)).total).toBe(18);

    await expect(credits.spend(w.id, w.luna, { amount: 19, reason: '3D generation', reference: 'job-2' })).rejects.toThrow(
      'Not enough credits',
    );
    expect(await spendCount(w)).toBe(1);
    expect((await balance(w)).total).toBe(18);

    await credits.giveBack(w.id, spent.spendId);
    expect((await balance(w)).total).toBe(30);
    await credits.giveBack(w.id, spent.spendId);
    expect((await balance(w)).total).toBe(30);

    const history = (await w.staff.get(`/payments/customers/${w.luna}/credits/history`).expect(200)).body as History;
    expect(history.data.map((entry) => [entry.kind, entry.amount])).toEqual([
      ['give_back', 12],
      ['spend', -12],
      ['grant', 30],
    ]);
    expect(history.data[1].reason).toBe('3D generation');
  });

  it('lets only one of two spends at once take the last credits (Review Focus 1)', async () => {
    const w = await workspace();
    await w.staff.post(`/payments/customers/${w.luna}/credits`, { amount: 10, expires_on: dateIn(90), reason: 'Trial' }).expect(201);

    const results = await Promise.allSettled([
      credits.spend(w.id, w.luna, { amount: 10, reason: 'Image', reference: 'race-a' }),
      credits.spend(w.id, w.luna, { amount: 10, reason: 'Image', reference: 'race-b' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((result) => result.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toContain('Not enough credits');
    expect(await balance(w)).toMatchObject({ total: 0, by_source: { staff: 0 } });
    expect(await spendCount(w)).toBe(1);
  });

  it('never spends an expired grant, and writes off what is left of it once', async () => {
    const w = await workspace();
    const expired = await grant(w, {
      source: 'staff',
      amount: 7,
      expiresAt: new Date(Date.now() - DAY),
      sourceKey: `staff:${newId()}`,
      reason: 'Old goodwill',
    });

    expect((await balance(w)).total).toBe(0);
    await expect(credits.spend(w.id, w.luna, { amount: 1, reason: 'Image', reference: 'too-late' })).rejects.toThrow(
      'Not enough credits',
    );

    await app.get(CreditExpiryHandler).handle();
    await app.get(CreditExpiryHandler).handle();

    const written = await prisma.inTenant(w.id, (tx) =>
      tx.creditEntry.findMany({ where: { grantId: expired.grantId, kind: 'expire' } }),
    );
    expect(written.map((entry) => entry.amount)).toEqual([-7]);
    const history = (await w.staff.get(`/payments/customers/${w.luna}/credits/history`).expect(200)).body as History;
    expect(history.data.map((entry) => [entry.kind, entry.amount])).toEqual([
      ['expire', -7],
      ['grant', 7],
    ]);
  });
});
