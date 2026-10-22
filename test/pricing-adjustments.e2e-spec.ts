import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { AdjustmentsService } from '../src/modules/pricing/adjustments.service';
import {
  customerGroupResponseSchema,
  deliverySpeedResponseSchema,
  discountTiersResponseSchema,
  marginOverrideResponseSchema,
  minSizeSurchargeResponseSchema,
} from '../src/modules/pricing/pricing-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

describe('pricing: margins, discount tiers, customer groups, delivery speeds, minimum-size surcharges', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  let adjustments: AdjustmentsService;
  const createdTenants: string[] = [];

  const http = () => request(app.getHttpServer());

  async function freshTenant() {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const as = (token: string) => ({
      post: (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => http().put(path).set('Authorization', `Bearer ${token}`).send(body),
      patch: (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
      get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
      delete: (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`),
    });
    return {
      id: tenant.id,
      owner: as((await tokens.issueForUser(tenant.id, owner.id)).accessToken),
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  const id = (response: request.Response) => (response.body as { id: string }).id;

  /** A category with one product in it. */
  async function catalog(tenant: Tenant) {
    const categoryId = id(await tenant.owner.post('/catalog/categories', { key: 'cast_metal', name: 'Cast metal parts' }).expect(201));
    const productId = id(
      await tenant.owner.post('/catalog/products', { category_id: categoryId, key: 'ring', name: 'Ring', kind: 'custom' }).expect(201),
    );
    return { categoryId, productId };
  }

  async function expect400(send: () => request.Test, body: object) {
    const response = await send();
    expect({ body, status: response.status }).toEqual({ body, status: 400 });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    tokens = moduleRef.get(AccessTokenService);
    adjustments = moduleRef.get(AdjustmentsService);
  });

  afterAll(async () => {
    await deleteTestTenants(prisma, createdTenants);
    await app.close();
  });

  it('takes the margin from the product, else its category, else the pricing profile', async () => {
    const tenant = await freshTenant();
    const { categoryId, productId } = await catalog(tenant);
    await tenant.owner.put('/pricing/profile', { margin_percent: '40', overhead_per_piece: '0', quote_valid_days: 7 }).expect(200);
    const margin = () =>
      prisma.inTenant(tenant.id, async (tx) => (await adjustments.load(tx, { categoryId, productId })).marginPercent.toFixed());

    expect(await margin()).toBe('40');

    const forCategory = await tenant.owner.put(`/pricing/categories/${categoryId}/margin`, { margin_percent: '30' }).expect(200);
    expectDocumented(marginOverrideResponseSchema, forCategory.body);
    expect(forCategory.body).toEqual({ category_id: categoryId, product_id: null, margin_percent: '30' });
    expect(await margin()).toBe('30');

    const forProduct = await tenant.owner.put(`/pricing/products/${productId}/margin`, { margin_percent: '55.5' }).expect(200);
    expectDocumented(marginOverrideResponseSchema, forProduct.body);
    expect(await margin()).toBe('55.5');

    // A second save replaces the override.
    await tenant.owner.put(`/pricing/products/${productId}/margin`, { margin_percent: '50' }).expect(200);
    expect(await margin()).toBe('50');

    await tenant.owner.delete(`/pricing/products/${productId}/margin`).expect(204);
    expect(await margin()).toBe('30');
    await tenant.owner.delete(`/pricing/categories/${categoryId}/margin`).expect(204);
    expect(await margin()).toBe('40');

    for (const body of [{ margin_percent: '1001' }, { margin_percent: '-1' }, { margin_percent: '1e2' }, { margin_percent: 40 }]) {
      await expect400(() => tenant.owner.put(`/pricing/products/${productId}/margin`, body), body);
    }

    const entries = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.findMany({ where: { action: 'pricing.changed', subjectType: 'margin_override' } }),
    );
    expect(entries).toHaveLength(5);
  });

  it('replaces the discount tiers as a whole and reads them back by quantity', async () => {
    const tenant = await freshTenant();

    const empty = await tenant.owner.get('/pricing/discount-tiers').expect(200);
    expectDocumented(discountTiersResponseSchema, empty.body);
    expect(empty.body).toEqual({ data: [] });

    const set = await tenant.owner
      .put('/pricing/discount-tiers', { tiers: [{ min_quantity: 50, percent: '10' }, { min_quantity: 10, percent: '5' }] })
      .expect(200);
    expectDocumented(discountTiersResponseSchema, set.body);
    expect(set.body).toEqual({
      data: [
        { min_quantity: 10, percent: '5' },
        { min_quantity: 50, percent: '10' },
      ],
    });
    expect((await tenant.owner.get('/pricing/discount-tiers').expect(200)).body).toEqual(set.body);

    const loaded = await prisma.inTenant(tenant.id, (tx) => adjustments.load(tx, { categoryId: newId(), productId: newId() }));
    expect(loaded.tiers.map((tier) => [tier.minQuantity, tier.percent.toFixed()])).toEqual([
      [10, '5'],
      [50, '10'],
    ]);

    for (const body of [
      { tiers: [{ min_quantity: 10, percent: '5' }, { min_quantity: 10, percent: '8' }] },
      { tiers: [{ min_quantity: 1, percent: '5' }] },
      { tiers: [{ min_quantity: 10.5, percent: '5' }] },
      { tiers: [{ min_quantity: 10, percent: '101' }] },
      { tiers: [{ min_quantity: 10, percent: '1e1' }] },
      { tiers: [{ min_quantity: 10, percent: '-5' }] },
    ]) {
      await expect400(() => tenant.owner.put('/pricing/discount-tiers', body), body);
    }

    await tenant.owner.put('/pricing/discount-tiers', { tiers: [] }).expect(200);
    expect((await tenant.owner.get('/pricing/discount-tiers').expect(200)).body).toEqual({ data: [] });
  });

  it('keeps customer groups with a markup or a discount of at most 50 %', async () => {
    const tenant = await freshTenant();

    const wholesale = await tenant.owner
      .post('/pricing/customer-groups', { key: 'wholesale', name: 'Wholesale', percent: '-10' })
      .expect(201);
    expectDocumented(customerGroupResponseSchema, wholesale.body);
    expect(wholesale.body).toMatchObject({ key: 'wholesale', name: 'Wholesale', percent: '-10' });
    await tenant.owner.post('/pricing/customer-groups', { key: 'agency', name: 'Agency', percent: '15' }).expect(201);

    await tenant.owner.post('/pricing/customer-groups', { key: 'wholesale', name: 'Again', percent: '0' }).expect(409);
    for (const body of [
      { key: 'deep', name: 'Deep', percent: '-60' },
      { key: 'high', name: 'High', percent: '101' },
      { key: 'Bad Key', name: 'Bad', percent: '0' },
    ]) {
      await expect400(() => tenant.owner.post('/pricing/customer-groups', body), body);
    }

    const patched = await tenant.owner.patch(`/pricing/customer-groups/${id(wholesale)}`, { percent: '-12.5' }).expect(200);
    expectDocumented(customerGroupResponseSchema, patched.body);
    expect(patched.body).toMatchObject({ key: 'wholesale', percent: '-12.5' });

    const listed = await tenant.owner.get('/pricing/customer-groups').expect(200);
    const groups = (listed.body as { data: { key: string }[] }).data;
    groups.forEach((group) => expectDocumented(customerGroupResponseSchema, group));
    expect(groups.map((group) => group.key)).toEqual(['agency', 'wholesale']);

    const loaded = await prisma.inTenant(tenant.id, (tx) => adjustments.load(tx, { categoryId: newId(), productId: newId() }));
    expect(loaded.groups.get('wholesale')?.toFixed()).toBe('-12.5');
  });

  it('keeps delivery speeds with at most one default', async () => {
    const tenant = await freshTenant();

    const standard = await tenant.owner
      .post('/pricing/delivery-speeds', { key: 'standard', name: 'Standard', surcharge_percent: '0', is_default: true })
      .expect(201);
    expectDocumented(deliverySpeedResponseSchema, standard.body);
    expect(standard.body).toMatchObject({ key: 'standard', surcharge_percent: '0', is_default: true });
    const express = await tenant.owner
      .post('/pricing/delivery-speeds', { key: 'express', name: 'Express', surcharge_percent: '20' })
      .expect(201);
    expect(express.body).toMatchObject({ is_default: false });

    await tenant.owner
      .post('/pricing/delivery-speeds', { key: 'rush', name: 'Rush', surcharge_percent: '50', is_default: true })
      .expect(409);
    await tenant.owner.patch(`/pricing/delivery-speeds/${id(express)}`, { is_default: true }).expect(409);
    await expect400(
      () => tenant.owner.post('/pricing/delivery-speeds', { key: 'rush', name: 'Rush', surcharge_percent: '501' }),
      { surcharge_percent: '501' },
    );

    // Moving the default: unset the old one, then set the new one.
    await tenant.owner.patch(`/pricing/delivery-speeds/${id(standard)}`, { is_default: false }).expect(200);
    const moved = await tenant.owner.patch(`/pricing/delivery-speeds/${id(express)}`, { is_default: true }).expect(200);
    expectDocumented(deliverySpeedResponseSchema, moved.body);

    const listed = await tenant.owner.get('/pricing/delivery-speeds').expect(200);
    const speeds = (listed.body as { data: { key: string; is_default: boolean }[] }).data;
    speeds.forEach((speed) => expectDocumented(deliverySpeedResponseSchema, speed));
    expect(speeds.map((speed) => [speed.key, speed.is_default])).toEqual([
      ['express', true],
      ['standard', false],
    ]);

    const loaded = await prisma.inTenant(tenant.id, (tx) => adjustments.load(tx, { categoryId: newId(), productId: newId() }));
    expect(loaded.defaultSpeedKey).toBe('express');
    expect(loaded.speeds.get('express')?.toFixed()).toBe('20');
  });

  it("keeps minimum-size surcharges, workspace-wide or for a category, in the measure's unit", async () => {
    const tenant = await freshTenant();
    const { categoryId, productId } = await catalog(tenant);

    const everywhere = await tenant.owner
      .post('/pricing/min-size-surcharges', { measure: 'bounding_box_z', below: '5', unit: 'mm', amount: '3' })
      .expect(201);
    expectDocumented(minSizeSurchargeResponseSchema, everywhere.body);
    expect(everywhere.body).toMatchObject({ category_id: null, measure: 'bounding_box_z', below: '5', unit: 'mm', amount: '3' });
    const forCategory = await tenant.owner
      .post('/pricing/min-size-surcharges', { category_id: categoryId, measure: 'volume', below: '1', unit: 'cm3', amount: '2' })
      .expect(201);
    expectDocumented(minSizeSurchargeResponseSchema, forCategory.body);

    for (const body of [
      { measure: 'volume', below: '1', unit: 'mm', amount: '2' },
      { measure: 'volume', below: '1', unit: 'furlong3', amount: '2' },
      { measure: 'resolution', below: '1', unit: 'piece', amount: '2' },
      { measure: 'volume', below: '0', unit: 'cm3', amount: '2' },
      { measure: 'volume', below: '1', unit: 'cm3', amount: '-2' },
    ]) {
      await expect400(() => tenant.owner.post('/pricing/min-size-surcharges', body), body);
    }
    await tenant.owner
      .post('/pricing/min-size-surcharges', { category_id: newId(), measure: 'volume', below: '1', unit: 'cm3', amount: '2' })
      .expect(404);

    const listed = await tenant.owner.get('/pricing/min-size-surcharges').expect(200);
    const surcharges = (listed.body as { data: unknown[] }).data;
    surcharges.forEach((surcharge) => expectDocumented(minSizeSurchargeResponseSchema, surcharge));
    expect(surcharges).toHaveLength(2);

    // The category's and the workspace-wide ones apply, with the threshold in the measure's base unit.
    const loaded = await prisma.inTenant(tenant.id, (tx) => adjustments.load(tx, { categoryId, productId }));
    expect(loaded.minSize.map((rule) => [rule.measure, rule.below.toFixed(), rule.amount.toFixed()]).sort()).toEqual([
      ['bounding_box_z', '5', '3'],
      ['volume', '1000', '2'],
    ]);
    const elsewhere = await prisma.inTenant(tenant.id, (tx) => adjustments.load(tx, { categoryId: newId(), productId: newId() }));
    expect(elsewhere.minSize.map((rule) => rule.measure)).toEqual(['bounding_box_z']);

    await tenant.owner.delete(`/pricing/min-size-surcharges/${id(forCategory)}`).expect(204);
    await tenant.owner.delete(`/pricing/min-size-surcharges/${id(forCategory)}`).expect(404);
  });

  it('keeps adjustments to staff who may see them, and to the workspace', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const idsB = await catalog(b);
    const group = id(await b.owner.post('/pricing/customer-groups', { key: 'vip', name: 'VIP', percent: '5' }).expect(201));
    const speed = id(await b.owner.post('/pricing/delivery-speeds', { key: 'rush', name: 'Rush', surcharge_percent: '30' }).expect(201));
    const surcharge = id(
      await b.owner.post('/pricing/min-size-surcharges', { measure: 'volume', below: '1', unit: 'cm3', amount: '2' }).expect(201),
    );

    for (const path of ['/pricing/discount-tiers', '/pricing/customer-groups', '/pricing/delivery-speeds', '/pricing/min-size-surcharges']) {
      await a.member.get(path).expect(403);
    }
    await a.member.put('/pricing/discount-tiers', { tiers: [] }).expect(403);

    await a.owner.put(`/pricing/categories/${idsB.categoryId}/margin`, { margin_percent: '10' }).expect(404);
    await a.owner.put(`/pricing/products/${idsB.productId}/margin`, { margin_percent: '10' }).expect(404);
    await a.owner.delete(`/pricing/products/${idsB.productId}/margin`).expect(404);
    await a.owner.patch(`/pricing/customer-groups/${group}`, { percent: '0' }).expect(404);
    await a.owner.patch(`/pricing/delivery-speeds/${speed}`, { surcharge_percent: '0' }).expect(404);
    await a.owner.delete(`/pricing/min-size-surcharges/${surcharge}`).expect(404);
    await a.owner
      .post('/pricing/min-size-surcharges', { category_id: idsB.categoryId, measure: 'volume', below: '1', unit: 'cm3', amount: '2' })
      .expect(404);

    for (const path of ['/pricing/customer-groups', '/pricing/delivery-speeds', '/pricing/min-size-surcharges']) {
      expect(((await a.owner.get(path).expect(200)).body as { data: unknown[] }).data).toEqual([]);
    }
  });
});
