import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { customerAddressesResponseSchema } from '../src/modules/customers/addresses';
import {
  createdCustomerResponseSchema,
  customerBandChoicesSchema,
  customerGroupChoicesSchema,
  customerInvitationSentResponseSchema,
  customerResponseSchema,
} from '../src/modules/customers/customer-response';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { IDENTITY_NOTIFIER } from '../src/modules/identity/identity-notifier';
import { CapturingIdentityNotifier } from './capturing-notifier';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

/** Records like the capturing notifier, but can fail the next customer invitation email once. */
class FailingOnceNotifier extends CapturingIdentityNotifier {
  failNext = false;

  override customerInvitationCreated(
    notice: Parameters<CapturingIdentityNotifier['customerInvitationCreated']>[0],
  ): ReturnType<CapturingIdentityNotifier['customerInvitationCreated']> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('the mail server is down'));
    }
    return super.customerInvitationCreated(notice);
  }
}

const STUDIO ={ name: 'Luna Jewels', line1: 'Hauptstrasse 1', city: 'Berlin', postal_code: '10115', country: 'DE' };

/** New customer in one request, the list's search, and the group and band choices (customers one go plan). */
describe('customers: one go, search and choices', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const notifier = new FailingOnceNotifier();
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());
  const id = (response: request.Response) => (response.body as { id: string }).id;

  function client(token: string) {
    return {
      post: (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    };
  }
  type Client = ReturnType<typeof client>;

  async function workspace() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const staff = client((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const memberUser = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const member = client((await tokens.issueForUser(tenant.id, memberUser.id)).accessToken);
    const wholesale = id(await staff.post('/pricing/customer-groups', { key: 'wholesale', name: 'Wholesale', percent: '0' }).expect(201));
    const retail = id(await staff.post('/pricing/customer-groups', { key: 'retail', name: 'Retail', percent: '5' }).expect(201));
    return { id: tenant.id, owner, staff, member, wholesale, retail };
  }
  type Workspace = Awaited<ReturnType<typeof workspace>>;

  /** A user holding only `permissions`, through a custom role. */
  async function holding(w: Workspace, permissions: string[]): Promise<Client> {
    const role = id(await w.staff.post('/roles', { name: `Desk ${newId()}`, permissions }).expect(201));
    const user = await createTestUser(prisma, w.id, { roles: [] });
    await w.staff.put(`/users/${user.id}/roles`, { role_ids: [role] }).expect(200);
    return client((await tokens.issueForUser(w.id, user.id)).accessToken);
  }

  const names = async (w: Workspace, query: string) => {
    const response = await w.staff.get(`/customers?limit=100${query}`).expect(200);
    expectDocumented(pageSchema(customerResponseSchema), response.body);
    return (response.body as { data: { name: string }[] }).data.map((customer) => customer.name).sort();
  };

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
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  describe('choices', () => {
    it('lets a member read the customer groups by name, without the percent', async () => {
      const w = await workspace();
      const res = await w.member.get('/customers/groups').expect(200);
      expectDocumented(customerGroupChoicesSchema, res.body);
      expect(res.body).toEqual({
        data: [
          { id: w.retail, key: 'retail', name: 'Retail' },
          { id: w.wholesale, key: 'wholesale', name: 'Wholesale' },
        ],
      });
    });

    it('gives the default band alone when the workspace set no bands', async () => {
      const w = await workspace();
      const res = await w.member.get('/customers/bands').expect(200);
      expectDocumented(customerBandChoicesSchema, res.body);
      expect(res.body).toEqual({ data: [{ key: 'standard', name: 'Standard', default: true }] });
    });

    it("gives the default band first, then the workspace's bands in order", async () => {
      const w = await workspace();
      await w.staff
        .put('/settings/customers.priority', {
          weights: { lifetime: 1, recent: 1, frequency: 1, payment: 1 },
          defaultBand: { key: 'normal', name: 'Normal' },
          bands: [
            { key: 'gold', name: 'Gold', from: 80, firstInLine: true, mayPickPartner: true },
            { key: 'silver', name: 'Silver', from: 50, firstInLine: false, mayPickPartner: false },
          ],
        })
        .expect(200);
      const res = await w.member.get('/customers/bands').expect(200);
      expectDocumented(customerBandChoicesSchema, res.body);
      expect(res.body).toEqual({
        data: [
          { key: 'normal', name: 'Normal', default: true },
          { key: 'gold', name: 'Gold', default: false },
          { key: 'silver', name: 'Silver', default: false },
        ],
      });
    });
  });

  describe('search', () => {
    it('finds customers by any part of the name, in any case, and by status', async () => {
      const w = await workspace();
      const luna = id(await w.staff.post('/customers', { name: 'Luna Jewels' }).expect(201));
      await w.staff.post('/customers', { name: 'Atelier LUNA' }).expect(201);
      await w.staff.post('/customers', { name: 'Northcast' }).expect(201);
      await w.staff.patch(`/customers/${luna}`, { status: 'disabled' }).expect(200);

      expect(await names(w, '&q=luna')).toEqual(['Atelier LUNA', 'Luna Jewels']);
      expect(await names(w, '&q=luna&status=active')).toEqual(['Atelier LUNA']);
      expect(await names(w, '&status=disabled')).toEqual(['Luna Jewels']);
    });

    it('matches % and _ in q literally', async () => {
      const w = await workspace();
      await w.staff.post('/customers', { name: '100% Gold' }).expect(201);
      await w.staff.post('/customers', { name: '1000 Gold' }).expect(201);
      expect(await names(w, `&q=${encodeURIComponent('0%')}`)).toEqual(['100% Gold']);
      expect(await names(w, '&q=0_')).toEqual([]);
    });

    it('finds customers by the whole name in any case, older ones past newer partial matches included', async () => {
      const w = await workspace();
      await w.staff.post('/customers', { name: 'Luna' }).expect(201);
      for (let n = 0; n < 3; n++) await w.staff.post('/customers', { name: `Luna ${n}` }).expect(201);
      await w.staff.post('/customers', { name: 'LUNA' }).expect(201);

      const response = await w.staff.get(`/customers?limit=2&name=${encodeURIComponent('  luna ')}`).expect(200);
      expectDocumented(pageSchema(customerResponseSchema), response.body);
      const body = response.body as { data: { name: string }[]; next_cursor: string | null };
      expect(body.data.map((customer) => customer.name)).toEqual(['LUNA', 'Luna']);
      expect(body.next_cursor).toBeNull();
      expect(await names(w, '&name=lun')).toEqual([]);
      expect(await names(w, '&name=luna&q=UN')).toEqual(['LUNA', 'Luna']);
    });

    it('matches % and _ in name literally, up to the 200 characters a name may have', async () => {
      const w = await workspace();
      const long = 'A'.repeat(199) + '%';
      await w.staff.post('/customers', { name: '100% Gold' }).expect(201);
      await w.staff.post('/customers', { name: '1000 Gold' }).expect(201);
      await w.staff.post('/customers', { name: long }).expect(201);
      expect(await names(w, `&name=${encodeURIComponent('100% gold')}`)).toEqual(['100% Gold']);
      expect(await names(w, `&name=${encodeURIComponent('100_ Gold')}`)).toEqual([]);
      expect(await names(w, `&name=${encodeURIComponent(long.toLowerCase())}`)).toEqual([long]);
      await w.staff.get(`/customers?name=${'a'.repeat(201)}`).expect(400);
      await w.staff.get('/customers?name=%20').expect(400);
    });

    it('refuses a q over 100 characters and an unknown status', async () => {
      const w = await workspace();
      await w.staff.get(`/customers?q=${'a'.repeat(101)}`).expect(400);
      await w.staff.get('/customers?status=archived').expect(400);
    });
  });

  describe('one go', () => {
    it('creates a customer with addresses, terms, the switch and a first invitation in one request', async () => {
      const w = await workspace();
      const email = `anna-${newId()}@luna.example.test`;
      const res = await w.staff
        .post('/customers', {
          name: 'Luna Jewels',
          customer_group_id: w.retail,
          may_pick_partner: true,
          shipping_address: STUDIO,
          vat_number: 'DE123456789',
          payment_terms: { terms: 'pay_later', days_to_pay: 30, credit_limit: '5000.00' },
          invitation: { email, role: 'owner' },
        })
        .expect(201);
      expectDocumented(createdCustomerResponseSchema, res.body);
      const notice = notifier.lastCustomerInvitationFor(email);
      expect(res.body).toMatchObject({
        name: 'Luna Jewels',
        may_pick_partner: true,
        customer_group: { id: w.retail },
        payment_terms: { terms: 'pay_later', days_to_pay: 30, credit_limit: '5000.00' },
        invitation: { id: notice?.invitationId, email, role: 'owner', expires_at: expect.any(String), email_status: 'queued' },
      });

      const addresses = await w.staff.get(`/customers/${id(res)}/addresses`).expect(200);
      expectDocumented(customerAddressesResponseSchema, addresses.body);
      expect(addresses.body).toEqual({ shipping_address: STUDIO, billing_address: null, vat_number: 'DE123456789' });
      expect(notifier.lastCustomerInvitationFor(email)).toMatchObject({ tenantId: w.id, customerName: 'Luna Jewels' });
    });

    it('answers a null invitation when the body asks for none', async () => {
      const w = await workspace();
      const res = await w.staff.post('/customers', { name: 'Uninvited Co' }).expect(201);
      expectDocumented(createdCustomerResponseSchema, res.body);
      expect((res.body as { invitation: unknown }).invitation).toBeNull();
    });

    it('records the same audit entries as the separate routes', async () => {
      const w = await workspace();
      const created = id(
        await w.staff
          .post('/customers', { name: 'Audited Co', vat_number: 'DE123456789', payment_terms: { terms: 'pay_first' } })
          .expect(201),
      );
      const actions = await prisma.inTenant(w.id, async (tx) =>
        (await tx.auditEntry.findMany({ where: { subjectType: 'customer', subjectId: created }, orderBy: { id: 'asc' } })).map(
          (entry) => entry.action,
        ),
      );
      expect(actions).toEqual(['customer.changed', 'customer.addresses_changed', 'customer.payment_terms.changed']);
    });

    it('treats null addresses on create as none given, recording no address change', async () => {
      const w = await workspace();
      const created = id(
        await w.staff.post('/customers', { name: 'Nulls Co', shipping_address: null, billing_address: null, vat_number: null }).expect(201),
      );
      const actions = await prisma.inTenant(w.id, async (tx) =>
        (await tx.auditEntry.findMany({ where: { subjectType: 'customer', subjectId: created } })).map((entry) => entry.action),
      );
      expect(actions).toEqual(['customer.changed']);
    });

    it('refuses pay later on a plan without it, naming payment_terms.terms and saving nothing', async () => {
      const w = await workspace();
      const plans = (await w.staff.get('/payments/plans').expect(200)).body as { data: { id: string; is_default: boolean }[] };
      const starter = plans.data.find((plan) => plan.is_default)!.id;
      await w.staff.patch(`/payments/plans/${starter}`, { features: [] }).expect(200);

      const res = await w.staff.post('/customers', { name: 'Later Co', payment_terms: { terms: 'pay_later' } }).expect(409);
      expect((res.body as { errors?: unknown }).errors).toEqual([{ path: 'payment_terms.terms', message: expect.any(String) }]);
      expect(await names(w, '&q=Later')).toEqual([]);
    });

    it('answers 201 with email_status failed when the invitation email fails after the customer is saved', async () => {
      const w = await workspace();
      const email = `ben-${newId()}@luna.example.test`;
      notifier.failNext = true;
      const res = await w.staff.post('/customers', { name: 'Mailless Co', invitation: { email, role: 'owner' } }).expect(201);
      expectDocumented(createdCustomerResponseSchema, res.body);
      expect(res.body).toMatchObject({ name: 'Mailless Co', invitation: { email, role: 'owner', email_status: 'failed' } });
      expect(await names(w, '&q=Mailless')).toEqual(['Mailless Co']);
    });

    it('answers 201 with email_status failed when a staff invitation email fails, the invitation saved', async () => {
      const w = await workspace();
      const customer = id(await w.staff.post('/customers', { name: 'Resend Co' }).expect(201));
      const email = `cleo-${newId()}@luna.example.test`;
      notifier.failNext = true;
      const failed = await w.staff.post(`/customers/${customer}/invitations`, { email, role: 'buyer' }).expect(201);
      expectDocumented(customerInvitationSentResponseSchema, failed.body);
      expect(failed.body).toMatchObject({ email, role: 'buyer', email_status: 'failed' });
      const saved = await prisma.inTenant(w.id, (tx) =>
        tx.customerInvitation.count({ where: { id: (failed.body as { id: string }).id } }),
      );
      expect(saved).toBe(1);

      // Inviting the same email again is how staff send it again.
      const again = await w.staff.post(`/customers/${customer}/invitations`, { email, role: 'buyer' }).expect(201);
      expect(again.body).toMatchObject({ email, email_status: 'queued' });
      expect(notifier.lastCustomerInvitationFor(email)?.invitationId).toBe((again.body as { id: string }).id);
    });

    it('saves nothing and sends nothing when the invitation is refused', async () => {
      const w = await workspace();
      const sent = notifier.customerInvitations.length;
      const res = await w.staff
        .post('/customers', {
          name: 'Refused Co',
          shipping_address: STUDIO,
          payment_terms: { terms: 'pay_later' },
          invitation: { email: w.owner.email, role: 'owner' },
        })
        .expect(409);
      expect((res.body as { errors?: unknown }).errors).toEqual([{ path: 'invitation.email', message: expect.any(String) }]);
      expect(await names(w, '&q=Refused')).toEqual([]);
      expect(notifier.customerInvitations.length).toBe(sent);
    });

    it('refuses payment terms from someone without payment.write, saving nothing', async () => {
      const w = await workspace();
      const desk = await holding(w, ['customer.read', 'customer.write']);
      await desk.post('/customers', { name: 'Terms Co', payment_terms: { terms: 'pay_first' } }).expect(403);
      await desk.post('/customers', { name: 'Plain Co' }).expect(201);
      expect(await names(w, '&q=Co')).toEqual(['Plain Co']);
    });
  });
});
