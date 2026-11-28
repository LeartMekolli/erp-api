import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { skillListResponseSchema, skillResponseSchema, userSkillListResponseSchema } from './skill-response';
import type { SkillResponse, UserSkillResponse } from './skill-response';
import { SkillsService } from './skills.service';

const idSchema = z.uuid();

const listSchema = z.object({
  include_archived: z.enum(['true', 'false']).optional(),
});

const nameSchema = z.string().trim().min(1).max(100);

const createSchema = z.object({ name: nameSchema });

const updateSchema = z
  .object({ name: nameSchema.optional(), archived: z.boolean().optional() })
  .refine((body) => body.name !== undefined || body.archived !== undefined, 'Give name, archived or both');

const setSkillsSchema = z.object({
  skills: z
    .array(z.object({ skill_id: z.uuid(), expires_on: z.iso.date().nullable() }))
    .max(100)
    .refine((skills) => new Set(skills.map((held) => held.skill_id)).size === skills.length, 'skill_id must not repeat'),
});

/** The workspace's skill catalogue (Workflow 2 spec, goal 9). */
@Controller('skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @ApiDoc({
    summary: "List the workspace's skills by name, leaving archived ones out unless asked.",
    description:
      'Each skill carries `holders_count` (active staff whose last day is not past), `expiring_soon_count` ' +
      '(of those, last day within the next 30 days), `expired_count` (active staff past their last day) and ' +
      "`required_by` (the steps of each workflow's current version that require it), in the workspace's zone.",
    query: listSchema,
    response: skillListResponseSchema,
    errors: [400],
  })
  @RequirePermission('user.read')
  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>,
  ): Promise<{ data: SkillResponse[] }> {
    return this.skills.list(tenantId, query.include_archived === 'true');
  }

  @ApiDoc({
    summary: 'Add a skill a workflow step may require.',
    description: 'Names are unique per workspace regardless of case (409).',
    body: createSchema,
    response: skillResponseSchema,
    errors: [400, 409],
  })
  @RequirePermission('settings.write')
  @Post()
  create(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ): Promise<SkillResponse> {
    return this.skills.create(auth, body.name);
  }

  @ApiDoc({
    summary: 'Rename a skill, or archive or restore it.',
    description:
      'An archived skill can no longer be given or required, and staff who hold it count as not holding it, ' +
      'so a step that requires it is open only to the owner until it is restored or the step requires another. ' +
      'Names are unique per workspace regardless of case (409).',
    body: updateSchema,
    response: skillResponseSchema,
    errors: [400, 404, 409],
  })
  @RequirePermission('settings.write')
  @Patch(':id')
  update(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ): Promise<SkillResponse> {
    return this.skills.update(auth, id, body);
  }
}

/** The skills a staff member holds (goal 10). */
@Controller('users')
export class UserSkillsController {
  constructor(private readonly skills: SkillsService) {}

  @ApiDoc({
    summary: "List a staff member's skills, with each one's expiry and whether it has expired or is archived.",
    response: userSkillListResponseSchema,
    errors: [400, 404],
  })
  @RequirePermission('user.read')
  @Get(':id/skills')
  list(
    @CurrentTenant() tenantId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ): Promise<{ data: UserSkillResponse[] }> {
    return this.skills.listOfUser(tenantId, id);
  }

  @ApiDoc({
    summary: "Replace a staff member's skills, each with an optional last day.",
    description:
      'Answers the skills the user now holds. An empty list takes every skill away. Nobody may change their ' +
      'own skills, an owner included (403 `own_skills`). An archived or unknown skill is a 400 and changes nothing, ' +
      "and so is a last day before the workspace's today (400 `expires_in_past`); a skill the person already holds, " +
      'sent with the same last day, is kept even if archived or expired. Skills must not repeat.',
    body: setSkillsSchema,
    response: userSkillListResponseSchema,
    errors: [400, 403, 404],
  })
  @RequirePermission('role.assign')
  @Put(':id/skills')
  set(
    @CurrentUser() auth: TenantAuth,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(setSkillsSchema)) body: z.infer<typeof setSkillsSchema>,
  ): Promise<{ data: UserSkillResponse[] }> {
    return this.skills.setOfUser(auth, id, body.skills);
  }
}
