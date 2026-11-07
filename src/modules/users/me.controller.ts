import { Body, Controller, Get, Patch } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { localeSchema } from '../../platform/tenant-input';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { TENANT_PERMISSIONS } from '../identity/permissions';
import { Authenticated } from '../identity/route-markers';
import { MeService } from './me.service';
import { USER_KINDS, userResponseSchema } from './user-response';

export const meResponseSchema = z.strictObject({
  /** Where the caller works: staff in the web app, partner people in its partner portal, customer people on the customer site. */
  kind: z.enum(USER_KINDS),
  user: userResponseSchema,
  /** The workspace signed in to; dates and money are shown in its time zone and currency. */
  workspace: z.strictObject({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    default_currency: z.string(),
    timezone: z.string(),
    /** Whether the workspace has a courier account, so labels can be bought when shipping. */
    labels_available: z.boolean(),
  }),
  roles: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
  permissions: z.array(z.enum(TENANT_PERMISSIONS)),
  memberships: z.array(
    z.strictObject({ organisation_type: z.string(), organisation_id: z.string(), role: z.string() }),
  ),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** What a person may change about themselves: only their language, for now. */
export const updateMeSchema = z.strictObject({ locale: localeSchema });
export type UpdateMe = z.infer<typeof updateMeSchema>;

/**
 * The caller's own identity (spec 4.7). There is deliberately no lookup of
 * other users by email or external id.
 */
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @ApiDoc({
    summary: "The caller's own kind, user, workspace, roles, permissions and memberships.",
    description:
      '`kind` says where the caller works (staff, partner or customer), whatever memberships they have left. ' +
      "`workspace` gives the name, currency and time zone screens show dates and money in, and whether labels can " +
      'be bought when shipping (`labels_available`), never anything of the courier account.',
    response: meResponseSchema,
    errors: [401],
  })
  @Authenticated()
  @Get()
  view(@CurrentUser() auth: TenantAuth): Promise<MeResponse> {
    return this.me.view(auth);
  }

  @ApiDoc({
    summary: 'Change your own language.',
    description:
      'The locale is a BCP 47 tag, stored canonical (`de-at` becomes `de-AT`). Nothing else about you can be ' +
      'changed here. Answers `/me` as it is now.',
    body: updateMeSchema,
    response: meResponseSchema,
    errors: [400, 401],
  })
  @Authenticated()
  @Patch()
  update(
    @CurrentUser() auth: TenantAuth,
    @Body(new ZodValidationPipe(updateMeSchema)) body: UpdateMe,
  ): Promise<MeResponse> {
    return this.me.update(auth, body);
  }
}
