import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { newId } from '../src/common/ids/uuid';
import { PrismaService } from '../src/database/prisma.service';
import { AccessTokenService } from '../src/modules/identity/access-token.service';
import {
  skillListResponseSchema,
  skillResponseSchema,
  userSkillListResponseSchema,
} from '../src/modules/users/skill-response';
import { expectDocumented } from './documented';
import { createTestTenant, createTestUser, deleteTestTenants } from './factories';

type Method = 'get' | 'post' | 'put' | 'patch';
type Skill = { id: string; name: string; archived: boolean; created_at: string };
type UserSkill = { skill: { id: string; name: string }; expires_on: string | null; expired: boolean };

describe('skills (Workflow 2, Task 1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: AccessTokenService;
  const createdTenants: string[] = [];

  const call = (method: Method, path: string, token: string, body?: object) => {
    const pending = request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`);
    return body ? pending.send(body) : pending;
  };

  const tokenFor = async (tenantId: string, userId: string) => (await tokens.issueForUser(tenantId, userId)).accessToken;

  async function freshTenant(): Promise<{ id: string; ownerId: string; ownerToken: string }> {
    const tenant = await createTestTenant(prisma);
    createdTenants.push(tenant.id);
    const owner = await createTestUser(prisma, tenant.id, { roles: ['owner'] });
    return { id: tenant.id, ownerId: owner.id, ownerToken: await tokenFor(tenant.id, owner.id) };
  }

  async function createSkill(token: string, name: string): Promise<Skill> {
    const response = await call('post', '/skills', token, { name }).expect(201);
    expectDocumented(skillResponseSchema, response.body);
    return response.body as Skill;
  }

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

  it('staff with settings.write keep a skill catalogue', async () => {
    const tenant = await freshTenant();
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const memberToken = await tokenFor(tenant.id, member.id);

    const casting = await createSkill(tenant.ownerToken, 'Casting');
    expect(casting).toMatchObject({ name: 'Casting', archived: false });
    await call('post', '/skills', tenant.ownerToken, { name: 'casting' }).expect(409);
    await call('post', '/skills', tenant.ownerToken, { name: '  ' }).expect(400);

    const renamed = await call('patch', `/skills/${casting.id}`, tenant.ownerToken, { name: 'Lost-wax casting' }).expect(
      200,
    );
    expectDocumented(skillResponseSchema, renamed.body);
    expect(renamed.body).toMatchObject({ id: casting.id, name: 'Lost-wax casting', archived: false });

    const polishing = await createSkill(tenant.ownerToken, 'Polishing');
    await call('patch', `/skills/${polishing.id}`, tenant.ownerToken, { name: 'lost-wax CASTING' }).expect(409);
    await call('patch', `/skills/${newId()}`, tenant.ownerToken, { archived: true }).expect(404);

    const archived = await call('patch', `/skills/${polishing.id}`, tenant.ownerToken, { archived: true }).expect(200);
    expect(archived.body).toMatchObject({ id: polishing.id, archived: true });

    const active = await call('get', '/skills', memberToken).expect(200);
    expectDocumented(skillListResponseSchema, active.body);
    expect((active.body as { data: Skill[] }).data.map((skill) => skill.name)).toEqual(['Lost-wax casting']);

    const all = await call('get', '/skills?include_archived=true', memberToken).expect(200);
    expectDocumented(skillListResponseSchema, all.body);
    expect((all.body as { data: Skill[] }).data.map((skill) => [skill.name, skill.archived])).toEqual([
      ['Lost-wax casting', false],
      ['Polishing', true],
    ]);

    await call('patch', `/skills/${polishing.id}`, tenant.ownerToken, { archived: false }).expect(200);
    await call('post', '/skills', memberToken, { name: 'Final QC' }).expect(403);
    await call('patch', `/skills/${casting.id}`, memberToken, { archived: true }).expect(403);
  });

  it('gives a member skills with an expiry, and replaces the set', async () => {
    const tenant = await freshTenant();
    const member = await createTestUser(prisma, tenant.id, { roles: ['member'] });
    const memberToken = await tokenFor(tenant.id, member.id);
    const casting = await createSkill(tenant.ownerToken, 'Casting');
    const finalQc = await createSkill(tenant.ownerToken, 'Final QC');
    const retired = await createSkill(tenant.ownerToken, 'Retired');
    await call('patch', `/skills/${retired.id}`, tenant.ownerToken, { archived: true }).expect(200);

    const set = await call('put', `/users/${member.id}/skills`, tenant.ownerToken, {
      skills: [
        { skill_id: casting.id, expires_on: null },
        { skill_id: finalQc.id, expires_on: '2020-01-31' },
      ],
    }).expect(200);
    expectDocumented(userSkillListResponseSchema, set.body);

    const read = await call('get', `/users/${member.id}/skills`, memberToken).expect(200);
    expectDocumented(userSkillListResponseSchema, read.body);
    expect((read.body as { data: UserSkill[] }).data).toEqual([
      { skill: { id: casting.id, name: 'Casting' }, expires_on: null, expired: false },
      { skill: { id: finalQc.id, name: 'Final QC' }, expires_on: '2020-01-31', expired: true },
    ]);

    await call('put', `/users/${member.id}/skills`, tenant.ownerToken, {
      skills: [{ skill_id: finalQc.id, expires_on: '2999-12-31' }],
    }).expect(200);
    const replaced = await call('get', `/users/${member.id}/skills`, tenant.ownerToken).expect(200);
    expect((replaced.body as { data: UserSkill[] }).data).toEqual([
      { skill: { id: finalQc.id, name: 'Final QC' }, expires_on: '2999-12-31', expired: false },
    ]);

    // Audited like role changes, the skills in id order.
    const entry = await prisma.inTenant(tenant.id, (tx) =>
      tx.auditEntry.findFirstOrThrow({
        where: { action: 'user.skills_changed', subjectId: member.id },
        orderBy: { createdAt: 'desc' },
      }),
    );
    const before = [
      { skill_id: casting.id, expires_on: null },
      { skill_id: finalQc.id, expires_on: '2020-01-31' },
    ].sort((a, b) => a.skill_id.localeCompare(b.skill_id));
    expect(entry).toMatchObject({
      actorId: tenant.ownerId,
      before: { skills: before },
      after: { skills: [{ skill_id: finalQc.id, expires_on: '2999-12-31' }] },
    });

    // An archived or unknown skill, a repeated skill or a bad date is refused, and the set is unchanged.
    for (const skills of [
      [{ skill_id: retired.id, expires_on: null }],
      [{ skill_id: newId(), expires_on: null }],
      [
        { skill_id: casting.id, expires_on: null },
        { skill_id: casting.id, expires_on: '2999-12-31' },
      ],
      [{ skill_id: casting.id, expires_on: '31.12.2999' }],
    ]) {
      await call('put', `/users/${member.id}/skills`, tenant.ownerToken, { skills }).expect(400);
    }
    const unchanged = await call('get', `/users/${member.id}/skills`, tenant.ownerToken).expect(200);
    expect((unchanged.body as { data: UserSkill[] }).data.map((held) => held.skill.id)).toEqual([finalQc.id]);

    // An empty set takes every skill away.
    await call('put', `/users/${member.id}/skills`, tenant.ownerToken, { skills: [] }).expect(200, { data: [] });

    await call('put', `/users/${member.id}/skills`, memberToken, { skills: [] }).expect(403);
  });

  it('lets role.assign give skills without settings.write, and the reverse', async () => {
    const tenant = await freshTenant();
    const lead = await createTestUser(prisma, tenant.id, { roles: [] });
    const leadToken = await tokenFor(tenant.id, lead.id);
    const role = (
      await call('post', '/roles', tenant.ownerToken, {
        name: 'Staff lead',
        permissions: ['user.read', 'role.assign'],
      }).expect(201)
    ).body as { id: string };
    await call('put', `/users/${lead.id}/roles`, tenant.ownerToken, { role_ids: [role.id] }).expect(200);
    const casting = await createSkill(tenant.ownerToken, 'Casting');

    await call('post', '/skills', leadToken, { name: 'Polishing' }).expect(403);
    await call('put', `/users/${lead.id}/skills`, leadToken, {
      skills: [{ skill_id: casting.id, expires_on: null }],
    }).expect(200);

    await call('put', `/roles/${role.id}/permissions`, tenant.ownerToken, { permissions: ['settings.write'] }).expect(200);
    await call('post', '/skills', leadToken, { name: 'Polishing' }).expect(201);
    await call('put', `/users/${lead.id}/skills`, leadToken, { skills: [] }).expect(403);
    await call('get', '/skills', leadToken).expect(403);
  });

  it("keeps one workspace's skills from another", async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const casting = await createSkill(tenant.ownerToken, 'Casting');
    // The same name is free in another workspace.
    await createSkill(other.ownerToken, 'Casting');

    await call('patch', `/skills/${casting.id}`, other.ownerToken, { archived: true }).expect(404);
    await call('put', `/users/${other.ownerId}/skills`, other.ownerToken, {
      skills: [{ skill_id: casting.id, expires_on: null }],
    }).expect(400);
    await call('get', `/users/${tenant.ownerId}/skills`, other.ownerToken).expect(404);
    await call('put', `/users/${tenant.ownerId}/skills`, other.ownerToken, { skills: [] }).expect(404);

    const listed = await call('get', '/skills', other.ownerToken).expect(200);
    expect((listed.body as { data: Skill[] }).data.map((skill) => skill.id)).not.toContain(casting.id);
  });
});
