import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { buildJournal } from '../src/modules/payments/ledger';
import { LedgerService } from '../src/modules/payments/ledger.service';
import { ledgerJournalResponseSchema } from '../src/modules/payments/payment-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

const d = (value: string) => new Prisma.Decimal(value);

interface JournalBody {
  id: string;
  kind: string;
  provider_object_id: string | null;
  lines: { account: string; amount: string }[];
}

/**
 * The ledger (Payments plan, Task 2): journals that always balance, never change, and are posted
 * once per provider fact.
 */
describe('payments: the ledger', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let ledger: LedgerService;
  const createdTenants: string[] = [];
  const previousPrefix = process.env.QUEUE_PREFIX;

  const http = () => request(app.getHttpServer());

  /** A workspace with a customer, its owner and a member, and a customer's person. */
  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const customerId = await prisma.inTenant(tenant.id, async (tx) => (await tx.customer.create({ data: { name: 'Anna' } })).id);
    const buyer = await createTestUser(prisma, tenant.id, { roles: [] });
    await prisma.inTenant(tenant.id, async (tx) => {
      await tx.user.update({ where: { id: buyer.id }, data: { kind: 'customer' } });
      await tx.organisationMembership.create({
        data: { userId: buyer.id, organisationType: 'customer', organisationId: customerId, role: 'buyer' },
      });
    });
    return {
      id: tenant.id,
      customerId,
      ownerId: owner.id,
      owner: (await tokens.issueForUser(tenant.id, owner.id)).accessToken,
      member: (await tokens.issueForUser(tenant.id, member.id)).accessToken,
      buyer: (await tokens.issueForUser(tenant.id, buyer.id)).accessToken,
    };
  }

  const post = (tenantId: string, customerId: string, kind: 'order_billed' | 'payment_received', providerObjectId?: string) =>
    prisma.inTenant(tenantId, (tx) =>
      ledger.post(tx, {
        ...(kind === 'order_billed'
          ? buildJournal(kind, [
              { account: 'customer_receivable', amount: d('119.00'), customerId },
              { account: 'sales', amount: d('-100.00'), customerId },
              { account: 'tax_payable', amount: d('-19.00') },
            ])
          : buildJournal(kind, [
              { account: 'stripe_balance', amount: d('119.00') },
              { account: 'customer_receivable', amount: d('-119.00'), customerId },
            ])),
        occurredAt: new Date(),
        currency: 'EUR',
        customerId,
        providerObjectId,
      }),
    );

  const receivable = (tenantId: string, customerId: string) =>
    prisma.inTenant(tenantId, (tx) => ledger.balance(tx, 'customer_receivable', { customerId }));

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = `t${randomBytes(6).toString('hex')}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(AccessTokenService);
    ledger = app.get(LedgerService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
    if (previousPrefix === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = previousPrefix;
  });

  it('leaves the receivable at zero once a billed order is paid', async () => {
    const ws = await workspace();

    await post(ws.id, ws.customerId, 'order_billed', 'in_1');
    expect((await receivable(ws.id, ws.customerId)).toFixed(2)).toBe('119.00');
    await post(ws.id, ws.customerId, 'payment_received', 'pi_1');

    expect((await receivable(ws.id, ws.customerId)).toFixed(2)).toBe('0.00');
  });

  it('posts the same provider fact once', async () => {
    const ws = await workspace();

    const first = await post(ws.id, ws.customerId, 'payment_received', 'pi_1');
    const again = await post(ws.id, ws.customerId, 'payment_received', 'pi_1');

    expect(first.created).toBe(true);
    expect(again).toEqual({ journalId: first.journalId, created: false });
    expect(await prisma.inTenant(ws.id, (tx) => tx.ledgerJournal.count())).toBe(1);
  });

  it('refuses, at commit, a journal whose lines do not sum to zero', async () => {
    const ws = await workspace();

    await expect(
      prisma.inTenant(ws.id, (tx) =>
        tx.ledgerJournal.create({
          data: {
            kind: 'payment_received',
            occurredAt: new Date(),
            currency: 'EUR',
            memo: '',
            lines: {
              create: [
                { account: 'stripe_balance', amount: d('10.00') },
                { account: 'customer_receivable', amount: d('-9.00') },
              ],
            },
          },
        }),
      ),
    ).rejects.toThrow(/does not balance/);
    expect(await prisma.inTenant(ws.id, (tx) => tx.ledgerJournal.count())).toBe(0);
  });

  it('refuses, at commit, a journal with a single line', async () => {
    const ws = await workspace();

    await expect(
      prisma.inTenant(ws.id, (tx) =>
        tx.ledgerJournal.create({
          data: {
            kind: 'payment_received',
            occurredAt: new Date(),
            currency: 'EUR',
            memo: '',
            lines: { create: [{ account: 'stripe_balance', amount: d('10.00') }] },
          },
        }),
      ),
    ).rejects.toThrow(/does not balance/);
  });

  it('refuses, at commit, a journal without lines', async () => {
    const ws = await workspace();

    await expect(
      prisma.inTenant(ws.id, (tx) =>
        tx.ledgerJournal.create({
          data: { kind: 'payment_received', occurredAt: new Date(), currency: 'EUR', memo: '' },
        }),
      ),
    ).rejects.toThrow(/does not balance/);
    expect(await prisma.inTenant(ws.id, (tx) => tx.ledgerJournal.count())).toBe(0);
  });

  it('refuses a line of zero', async () => {
    const ws = await workspace();

    await expect(
      prisma.inTenant(ws.id, (tx) =>
        tx.ledgerJournal.create({
          data: {
            kind: 'payment_received',
            occurredAt: new Date(),
            currency: 'EUR',
            memo: '',
            lines: {
              create: [
                { account: 'stripe_balance', amount: d('10.00') },
                { account: 'customer_receivable', amount: d('-10.00') },
                { account: 'provider_fees', amount: d('0.00') },
              ],
            },
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('reverses a journal, and only once', async () => {
    const ws = await workspace();
    const billed = await post(ws.id, ws.customerId, 'order_billed', 'in_1');

    const reversal = await prisma.inTenant(ws.id, (tx) => ledger.reverse(tx, billed.journalId, 'Billed by mistake', ws.ownerId));

    expect(reversal.created).toBe(true);
    expect((await receivable(ws.id, ws.customerId)).toFixed(2)).toBe('0.00');
    const row = await prisma.inTenant(ws.id, (tx) => tx.ledgerJournal.findUniqueOrThrow({ where: { id: reversal.journalId } }));
    expect(row).toMatchObject({ kind: 'reversal', reversesJournalId: billed.journalId, memo: 'Billed by mistake' });
    await expect(prisma.inTenant(ws.id, (tx) => ledger.reverse(tx, billed.journalId, 'Again'))).rejects.toMatchObject({ status: 409 });
  });

  it('lists the journals newest first, with their lines, and filters by customer and date', async () => {
    const ws = await workspace();
    const billed = await post(ws.id, ws.customerId, 'order_billed', 'in_1');
    const paid = await post(ws.id, ws.customerId, 'payment_received', 'pi_1');

    const res = await http().get(`/payments/ledger?customer_id=${ws.customerId}`).set('Authorization', `Bearer ${ws.owner}`).expect(200);

    expectDocumented(pageSchema(ledgerJournalResponseSchema), res.body);
    const data = (res.body as { data: JournalBody[] }).data;
    expect(data.map((journal) => journal.id)).toEqual([paid.journalId, billed.journalId]);
    expect(data[1]?.lines.map((line) => [line.account, line.amount])).toEqual(
      expect.arrayContaining([
        ['customer_receivable', '119.00'],
        ['sales', '-100.00'],
        ['tax_payable', '-19.00'],
      ]),
    );

    const none = await http().get('/payments/ledger?from=2999-01-01').set('Authorization', `Bearer ${ws.owner}`).expect(200);
    expect((none.body as { data: unknown[] }).data).toEqual([]);
  });

  it('lets a member read the ledger and keeps a customer person out', async () => {
    const ws = await workspace();

    await http().get('/payments/ledger').set('Authorization', `Bearer ${ws.member}`).expect(200);
    await http().get('/payments/ledger').set('Authorization', `Bearer ${ws.buyer}`).expect(403);
    await http().get('/payments/ledger').expect(401);
  });

  it("does not show one workspace's journals to another", async () => {
    const a = await workspace();
    const b = await workspace();
    await post(a.id, a.customerId, 'payment_received', 'pi_1');

    const res = await http().get('/payments/ledger').set('Authorization', `Bearer ${b.owner}`).expect(200);

    expect((res.body as { data: unknown[] }).data).toEqual([]);
  });
});
