import type request from 'supertest';
import type { PrismaService } from '../src/database/prisma.service';
import type { AccessTokenService } from '../src/modules/identity/access-token.service';
import { pricedAssembly } from './assembly-fixtures';
import { measuredDesign } from './catalog-fixtures';
import { createTestTenant, createTestUser } from './factories';

/** An HTTP client signed in as one person. */
export interface Client {
  post(path: string, body?: object): request.Test;
  put(path: string, body: object): request.Test;
  patch(path: string, body: object): request.Test;
  get(path: string): request.Test;
}
export type As = (token: string) => Client;

export interface Order {
  id: string;
  number: number;
  total: string;
  lines: { id: string; position: number; total: string; group_id: string }[];
}
export interface Claim {
  id: string;
  state: string;
  lines: { id: string; pieces: number; decision: { outcome: string; remake_group_id: string | null } | null }[];
  shipment: { courier: string | null; tracking: string | null; delivered_at: string | null } | null;
}

const KEYS = {
  secret_key: 'sk_test_51SecretValueAAAA',
  publishable_key: 'pk_test_51PublishableBBBB',
  webhook_secret: 'whsec_paymentsCCCC',
  connect_webhook_secret: 'whsec_connectDDDD',
};
const ADDRESS = { name: 'Luna Jewels', line1: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
const today = () => new Date().toISOString().slice(0, 10);

/**
 * A workspace that takes, makes and delivers orders: the pendant set (`pricedAssembly`, with the cast part
 * under it); CastCo and MetalWorks, each able to make the whole cast line, with a member; Luna Jewels paying
 * by bank transfer, with a buyer. The tenant id is pushed onto `run.createdTenants` for the spec to delete.
 * `run.runMetal` is the spec's own metal: feed snapshots are platform-wide, so silver is at its fallback.
 */
export async function orderWorkspace(
  prisma: PrismaService,
  tokens: AccessTokenService,
  as: As,
  run: { runMetal: string; createdTenants: string[] },
) {
  const person = async (tenantId: string, kind: 'customer' | 'partner', organisationId: string, role: string) => {
    const user = await createTestUser(prisma, tenantId, { roles: [] });
    await prisma.inTenant(tenantId, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { kind } });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationType: kind, organisationId, role } });
    });
    return as((await tokens.issueForUser(tenantId, user.id)).accessToken);
  };

  const tenant = await createTestTenant(prisma);
  run.createdTenants.push(tenant.id);
  const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
  const staff = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
  const set = await pricedAssembly(staff, prisma, { id: tenant.id, staffUserId: owner.id, runMetal: run.runMetal });
  const cast = set.cast;
  await staff.patch(`/catalog/products/${cast.productId}`, { published: true }).expect(200);
  await staff.post('/orders/shipping-methods', { key: 'courier', name: 'Standard courier', price: '9.90' }).expect(201);
  await staff.put('/payments/account', KEYS).expect(200);
  const agreement = (await measuredDesign(prisma, tenant.id, owner.id, { status: 'uploaded', measures: [] })).versionId;

  const { printPattern, castingTree, casting, polishing } = cast.steps;
  const { finalQc, packing } = cast.workflow.notPriced;
  const workshop = async (name: string) => {
    const id = ((await staff.post('/partners', { name, display_name: name }).expect(201)).body as { id: string }).id;
    await staff
      .put(`/partners/${id}/capabilities`, {
        capabilities: [printPattern, castingTree, casting, polishing, finalQc, packing].map((step_type_id) => ({
          step_type_id,
          capacity: 200,
          capacity_period: 'week',
        })),
      })
      .expect(200);
    await staff.put(`/partners/${id}/offerings`, { option_value_ids: [cast.v.silver, cast.v.polished] }).expect(200);
    await staff.post(`/partners/${id}/prices/copy-from-workspace`).expect(200);
    await staff.put(`/partners/${id}/agreement`, { file_version_id: agreement, signed_on: '2026-10-24' }).expect(200);
    await staff.post(`/partners/${id}/approve`).expect(200);
    return { id, person: await person(tenant.id, 'partner', id, 'member') };
  };
  const castco = await workshop('CastCo');
  const metalworks = await workshop('MetalWorks');

  const luna = ((await staff.post('/customers', { name: 'Luna Jewels' }).expect(201)).body as { id: string }).id;
  const lunaDesign = await measuredDesign(prisma, tenant.id, owner.id, { customerId: luna });
  const buyer = await person(tenant.id, 'customer', luna, 'buyer');

  /** Luna's order, paid by bank transfer, made by CastCo unless `inHouse`: 10 cast parts, or 3 pendant sets with `assembly`. */
  const placed = async (options: { inHouse?: boolean; assembly?: boolean } = {}) => {
    const body = options.assembly
      ? { product_id: set.set, options: { material: 'silver_925', finish: 'polished' }, quantity: 3, customer_id: luna }
      : {
          product_id: cast.productId,
          options: { material: 'silver_925', finish: 'polished' },
          size: { scale: '1.5' },
          quantity: 10,
          file_version_id: lunaDesign.versionId,
          customer_id: luna,
        };
    const quote = ((await staff.post('/pricing/quotes', body).expect(201)).body as { quote: { id: string } }).quote.id;
    const order = (await staff.post('/orders', { customer_id: luna, lines: [{ quote_id: quote }], address: ADDRESS, shipping_method: 'courier' }).expect(201))
      .body as Order;
    await staff.post(`/orders/${order.id}/paid-by-hand`, { reference: `Transfer ${order.number}`, received_on: today() }).expect(200);
    const group = order.lines[0].group_id;
    if (!options.inHouse && !options.assembly) {
      await staff.post(`/partners/jobs/${group}/offer`, { partner_id: castco.id }).expect(201);
      await castco.person.post(`/partner-portal/partners/${castco.id}/jobs/${group}/accept`).expect(200);
    }
    return order;
  };

  /**
   * `placed`, then delivered. Pieces are finished directly: moving them is Workflow's to test.
   */
  const delivered = async (options: { inHouse?: boolean; assembly?: boolean } = {}) => {
    const order = await placed(options);
    // Every group of the order: the line's, and an assembly's parts'.
    await prisma.inTenant(tenant.id, (tx) =>
      tx.workOrder.updateMany({
        where: { group: { OR: [{ orderLine: { is: { orderId: order.id } } }, { orderLinePart: { is: { line: { orderId: order.id } } } }] } },
        data: { status: 'finished', currentStepId: null },
      }),
    );
    await staff.post(`/orders/${order.id}/ship`, { courier: 'DHL', tracking: 'JD0001' }).expect(200);
    await staff.post(`/orders/${order.id}/deliver`).expect(200);
    return order;
  };
  /** Luna's buyer claims 2 pieces of the first line as faulty, or `pieces`. */
  const claim = async (order: Order, pieces = 2) =>
    (
      await buyer
        .post(`/portal/customers/${luna}/orders/${order.id}/claims`, { reason: 'defect', description: 'Cracked shanks.', lines: [{ position: 0, pieces }] })
        .expect(201)
    ).body as Claim;

  return { id: tenant.id, ownerId: owner.id, staff, set, castco, metalworks, workshop, luna, buyer, person, placed, delivered, claim };
}
export type OrderWorkspace = Awaited<ReturnType<typeof orderWorkspace>>;
