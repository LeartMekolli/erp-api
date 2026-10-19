import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PrismaService } from '../../database/prisma.service';
import { CurrentTenant, CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { EventKey, isEventKey } from './catalogue';
import { validateTemplate } from './render';
import { TemplateEntry, TemplateOverrideResponse, TemplatesService } from './templates.service';

export const localeSchema = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Must be a locale such as en or en-GB');

/** Turns template problems into field errors, so a 400 names `subject` or `body`. */
function addTemplateIssues(event: EventKey, template: { subject: string; body: string }, ctx: z.RefinementCtx): void {
  for (const issue of validateTemplate(event, template)) {
    ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
  }
}

const overrideSchema = (event: EventKey) =>
  z
    .object({ subject: z.string(), body: z.string(), enabled: z.boolean().default(true) })
    .superRefine((template, ctx) => addTemplateIssues(event, template, ctx));

const previewSchema = z
  .object({
    event_key: z.string().refine(isEventKey, 'Unknown event'),
    locale: localeSchema,
    subject: z.string(),
    body: z.string(),
  })
  .superRefine((input, ctx) => {
    if (isEventKey(input.event_key)) {
      addTemplateIssues(input.event_key, input, ctx);
    }
  });

/**
 * Spec 6.3. Staff edit wording only: who receives a notification, and when,
 * stays in code (D68). Every saved override is validated against its event's
 * variables, so an invitation can never lose its link (Review Focus 2).
 */
@Controller('notification-templates')
export class TemplatesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TemplatesService,
  ) {}

  @RequirePermission('template.read')
  @Get()
  async list(@CurrentTenant() tenantId: string): Promise<{ data: TemplateEntry[] }> {
    return { data: await this.prisma.inTenant(tenantId, (tx) => this.templates.list(tx)) };
  }

  @RequirePermission('template.write')
  @Put(':event_key/:locale')
  save(
    @CurrentUser() auth: TenantAuth,
    @Param('event_key') event: string,
    @Param('locale', new ZodValidationPipe(localeSchema)) locale: string,
    @Body() body: unknown,
  ): Promise<TemplateOverrideResponse> {
    if (!isEventKey(event)) {
      throw new NotFoundException(`Unknown notification event: ${event}`);
    }
    // Throws a ZodError, rendered as a 400 listing each failing field.
    const input = overrideSchema(event).parse(body);
    return this.prisma.inTenant(auth.tenantId, (tx) => this.templates.save(tx, auth, event, locale, input));
  }

  /** Renders against sample data; stores nothing. */
  @RequirePermission('template.write')
  @Post('preview')
  @HttpCode(200)
  preview(
    @Body(new ZodValidationPipe(previewSchema)) body: z.infer<typeof previewSchema>,
  ): { subject: string; text: string; html: string } {
    return this.templates.preview(body.event_key as EventKey, { subject: body.subject, body: body.body });
  }
}
