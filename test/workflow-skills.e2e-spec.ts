import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { pageSchema } from '../src/common/pagination/page';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import { localDate } from '../src/modules/orders/dates';
import { moveResponseSchema, workOrderListItemSchema } from '../src/modules/workflow/work-order-response';
import { workflowVersionResponseSchema } from '../src/modules/workflow/workflow-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';
import { pricedCastPart } from './pricing-fixtures';

interface Piece {
  id: string;
  group_id: string;
  label: string;
  status: string;
  step: { key: string } | null;
  may_work: boolean;
}

/**
 * Workflow 2, Task 2: a step the workspace does in-house may require a skill. The cast workflow gets an
 * in-house "Stone setting" step after polishing that requires the skill "Setting"; the other steps are
 * the partner's and require none.
 */
describe('workflow: a step requires a skill', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];
  const runMetal = `testmetal_${randomBytes(4).toString('hex')}`;

  const http = () => request(app.getHttpServer());
  const id = (response: request.Response) => (response.body as { id: string }).id;

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
    });
    const ownerClient = as((await tokens.issueForUser(tenant.id, owner.id)).accessToken);
    const setup = await pricedCastPart(ownerClient, prisma, { id: tenant.id, staffUserId: owner.id, runMetal });

    const skillId = id(await ownerClient.post('/skills', { name: 'Setting' }).expect(201));
    const settingTypeId = id(
      await ownerClient.post('/pricing/step-types', { key: 'stone_setting', name: 'Stone setting', position: 45, summary_group: null }).expect(201),
    );
    const settingStep = { key: 'stone_setting', name: 'Stone setting', step_type_id: settingTypeId, done_by: 'workspace' };
    const version = await setup.workflow.setSteps([{ ...settingStep, required_skill_id: skillId }]);
    expectDocumented(workflowVersionResponseSchema, version.body);

    return {
      id: tenant.id,
      memberId: member.id,
      setup,
      skillId,
      settingStep,
      owner: ownerClient,
      member: as((await tokens.issueForUser(tenant.id, member.id)).accessToken),
    };
  }
  type Tenant = Awaited<ReturnType<typeof freshTenant>>;

  /** Starts a polished silver quote of `quantity` pieces; returns them in number order. */
  async function started(tenant: Tenant, quantity = 4): Promise<Piece[]> {
    const quoted = await tenant.owner
      .post('/pricing/quotes', {
        product_id: tenant.setup.productId,
        options: { material: 'silver_925', finish: 'polished' },
        size: { scale: '1.5' },
        file_version_id: tenant.setup.versionId,
        quantity,
      })
      .expect(201);
    const quoteId = (quoted.body as { quote: { id: string } }).quote.id;
    const group = (await tenant.owner.post('/workflow/groups', { quote_id: quoteId }).expect(201)).body as { id: string };
    const listed = await tenant.owner.get(`/workflow/work-orders?group_id=${group.id}&limit=100`).expect(200);
    return (listed.body as { data: Piece[] }).data;
  }

  const ids = (pieces: Piece[]) => pieces.map((piece) => piece.id);
  const pass = (client: Tenant['owner'], pieces: Piece[], atStep: string) =>
    client.post('/workflow/moves', { work_order_ids: ids(pieces), at_step: atStep, kind: 'pass' });

  /** The owner passes the pieces through polishing, so they wait at stone setting. */
  async function toSetting(tenant: Tenant, pieces: Piece[]) {
    for (const step of ['print_pattern', 'casting_tree', 'casting', 'polishing']) {
      const body = step === 'polishing' ? { answers: [{ item: 'surface', value: 'ok' }] } : {};
      await tenant.owner
        .post('/workflow/moves', { work_order_ids: ids(pieces), at_step: step, kind: 'pass', ...body })
        .expect(200);
    }
  }

  const giveSkill = (tenant: Tenant, expiresOn: string | null) =>
    tenant.owner
      .put(`/users/${tenant.memberId}/skills`, { skills: [{ skill_id: tenant.skillId, expires_on: expiresOn }] })
      .expect(200);
  const detail = (response: request.Response) => (response.body as { detail: string }).detail;
  const todayUtc = () => new Date().toISOString().slice(0, 10);

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
    await app.close();
  });

  it("refuses a move without the step's skill, and allows it with one", async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    await toSetting(tenant, pieces);

    // Steps without a skill stay open to anyone who may move pieces.
    const refused = await pass(tenant.member, pieces.slice(0, 1), 'stone_setting').expect(403);
    expect(detail(refused)).toBe('Moving pieces at Stone setting needs the skill Setting');
    const failRefused = await tenant.member
      .post('/workflow/moves', {
        work_order_ids: ids(pieces.slice(0, 1)),
        at_step: 'stone_setting',
        kind: 'fail',
        defect_id: tenant.setup.workflow.defects.crack,
        outcome: 'scrap',
        override_reason: 'Stone cracked the setting',
      })
      .expect(403);
    expect(detail(failRefused)).toBe('Moving pieces at Stone setting needs the skill Setting');

    // Expiring today still counts: the skill is held through its last day.
    await giveSkill(tenant, todayUtc());
    const moved = await pass(tenant.member, pieces.slice(0, 1), 'stone_setting').expect(200);
    expectDocumented(moveResponseSchema, moved.body);
    expect((moved.body as { data: Piece[] }).data[0]?.step?.key).toBe('final_qc');
  });

  it('refuses again once the skill expires or is taken away (Review Focus 3)', async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    await toSetting(tenant, pieces);

    await giveSkill(tenant, null);
    await pass(tenant.member, pieces.slice(0, 1), 'stone_setting').expect(200);

    await giveSkill(tenant, '2020-01-31');
    await pass(tenant.member, pieces.slice(1, 2), 'stone_setting').expect(403);

    await giveSkill(tenant, null);
    await pass(tenant.member, pieces.slice(1, 2), 'stone_setting').expect(200);

    await tenant.owner.put(`/users/${tenant.memberId}/skills`, { skills: [] }).expect(200);
    await pass(tenant.member, pieces.slice(2, 3), 'stone_setting').expect(403);

    // An archived skill counts as not held, even by staff who still hold it.
    await giveSkill(tenant, null);
    await tenant.owner.patch(`/skills/${tenant.skillId}`, { archived: true }).expect(200);
    await pass(tenant.member, pieces.slice(2, 3), 'stone_setting').expect(403);
  });

  it('lets the owner always move', async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    await toSetting(tenant, pieces);

    // The owner holds no skill at all, and the skill may even be archived.
    await tenant.owner.patch(`/skills/${tenant.skillId}`, { archived: true }).expect(200);
    await pass(tenant.owner, pieces, 'stone_setting').expect(200);
  });

  it('checks a correction against the step the piece is at', async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant, 2);
    await toSetting(tenant, pieces);
    const [atSetting, movedOn] = pieces as [Piece, Piece];
    await pass(tenant.owner, [movedOn], 'stone_setting').expect(200);
    const correct = (piece: Piece, toStep: string) =>
      tenant.member.post('/workflow/moves', {
        work_order_ids: [piece.id],
        kind: 'correction',
        to_step: toStep,
        comment: 'Put back by mistake',
      });

    // At stone setting: the member lacks its skill, wherever the piece would go.
    const refused = await correct(atSetting, 'polishing').expect(403);
    expect(detail(refused)).toBe('Moving pieces at Stone setting needs the skill Setting');

    // At final QC, which needs no skill: the member may put it back at stone setting.
    await correct(movedOn, 'stone_setting').expect(200);
    // Now it is at stone setting, so the same member can't take it away again.
    await correct(movedOn, 'final_qc').expect(403);

    await giveSkill(tenant, null);
    await correct(atSetting, 'polishing').expect(200);
  });

  it('refuses a skill on a partner step, or an unknown or archived one', async () => {
    const tenant = await freshTenant();
    const workflowId = id(await tenant.owner.post('/workflow/workflows', { key: 'setting_only', name: 'Setting only' }).expect(201));
    const path = `/workflow/workflows/${workflowId}/steps`;
    const put = (step: object) => tenant.owner.put(path, { steps: [{ ...tenant.settingStep, ...step }] });

    const onPartner = await put({ done_by: 'partner', required_skill_id: tenant.skillId }).expect(400);
    expect(detail(onPartner)).toMatch(/Stone setting/);
    const unknown = await put({ required_skill_id: newId() }).expect(400);
    expect(detail(unknown)).toMatch(/Stone setting/);
    await put({ required_skill_id: 'not-a-uuid' }).expect(400);

    const made = await put({ required_skill_id: tenant.skillId }).expect(200);
    expectDocumented(workflowVersionResponseSchema, made.body);
    expect((made.body as { steps: { key: string; required_skill_id: string | null }[] }).steps).toEqual([
      expect.objectContaining({ key: 'stone_setting', required_skill_id: tenant.skillId }),
    ]);
    // Left out, a step requires no skill.
    const open = await put({}).expect(200);
    expect((open.body as { steps: { required_skill_id: string | null }[] }).steps[0]?.required_skill_id).toBeNull();

    await tenant.owner.patch(`/skills/${tenant.skillId}`, { archived: true }).expect(200);
    const archived = await put({ required_skill_id: tenant.skillId }).expect(400);
    expect(detail(archived)).toMatch(/Stone setting/);
  });

  it('marks the pieces the caller may work, and filters to them', async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    const first = pieces[0] as Piece;
    await toSetting(tenant, pieces.slice(0, 2));
    const list = async (client: Tenant['owner'], query = '') => {
      const response = await client.get(`/workflow/work-orders?group_id=${first.group_id}&limit=100${query}`).expect(200);
      expectDocumented(pageSchema(workOrderListItemSchema), response.body);
      return (response.body as { data: Piece[] }).data;
    };
    const mayWork = (listed: Piece[]) => listed.map((piece) => [piece.step?.key, piece.may_work]);

    // Two pieces at stone setting, two at print pattern (a partner step, open to anyone who may move).
    expect(mayWork(await list(tenant.member))).toEqual([
      ['stone_setting', false],
      ['stone_setting', false],
      ['print_pattern', true],
      ['print_pattern', true],
    ]);
    expect((await list(tenant.member, '&workable=true')).map((piece) => piece.id)).toEqual(ids(pieces.slice(2)));
    expect(mayWork(await list(tenant.owner)).every(([, may]) => may === true)).toBe(true);
    expect(await list(tenant.owner, '&workable=true')).toHaveLength(4);

    await giveSkill(tenant, null);
    expect(mayWork(await list(tenant.member)).every(([, may]) => may === true)).toBe(true);
    expect(await list(tenant.member, '&workable=true')).toHaveLength(4);

    // The filter combines with the others.
    expect(await list(tenant.member, '&workable=true&step_key=stone_setting')).toHaveLength(2);
    await tenant.owner.put(`/users/${tenant.memberId}/skills`, { skills: [] }).expect(200);
    expect(await list(tenant.member, '&workable=true&step_key=stone_setting')).toEqual([]);
    // Only `true` filters; anything else is refused rather than ignored.
    await tenant.member.get(`/workflow/work-orders?workable=false`).expect(400);
    await tenant.member.get(`/workflow/work-orders?workable=yes`).expect(400);
  });

  it("reads a skill's last day in the workspace's time zone (review fix, Review Focus 5)", async () => {
    const tenant = await freshTenant();
    const pieces = await started(tenant);
    await toSetting(tenant, pieces);
    const setTimezone = (timezone: string) =>
      prisma.inTenant(tenant.id, (tx) => tx.tenant.update({ where: { id: tenant.id }, data: { timezone } }));

    // Today in Pago Pago (UTC−11), which is always before today in Kiritimati (UTC+14).
    await setTimezone('Pacific/Pago_Pago');
    await giveSkill(tenant, localDate(new Date(), 'Pacific/Pago_Pago'));
    await pass(tenant.member, pieces.slice(0, 1), 'stone_setting').expect(200);

    await setTimezone('Pacific/Kiritimati');
    await pass(tenant.member, pieces.slice(1, 2), 'stone_setting').expect(403);
  });
});
