import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApiDoc } from '../../docs/api-doc';
import { BriefingService } from '../ai/briefing.service';
import { askResponseSchema } from '../ai/run-response';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { AttentionService } from './attention.service';
import { dashboardResponseSchema } from './dashboard-response';
import type { DashboardResponse } from './dashboard-response';
import { ReportsService } from './reports.service';

const idParam = new ZodValidationPipe(z.uuid());

/** The staff dashboard (AI 1 spec, goals 5–9). */
@Controller('reports')
export class DashboardController {
  constructor(
    private readonly reports: ReportsService,
    private readonly attention: AttentionService,
    private readonly briefings: BriefingService,
  ) {}

  @ApiDoc({
    summary: 'This week against last week, what needs attention now, and the managers’ AI briefing.',
    description:
      "Weeks run from Monday in the workspace's time zone and are computed every 15 minutes. Money figures need " +
      '`payment.read` and partner figures `partner.read`; without them they are left out, never zeroed. `attention` is ' +
      'live: each kind follows the permission of the list it comes from, with its total and at most 20 items. `ai` is ' +
      'only there for staff holding `report.read`, `payment.read` and `partner.read`: the latest briefing, with ' +
      'dismissed suggestions and ones naming a record that is gone left out, or why AI is off.',
    response: dashboardResponseSchema,
    errors: [],
  })
  @RequirePermission('report.read')
  @Get('dashboard')
  async dashboard(@CurrentUser() auth: TenantAuth): Promise<DashboardResponse> {
    const numbers = await this.reports.dashboardNumbers(auth);
    const attention = await this.attention.list(auth, new Date());
    const ai = await this.briefings.section(auth);
    return { ...numbers, attention, ...(ai ? { ai } : {}) };
  }

  @ApiDoc({
    summary: 'Have the AI write a new briefing now; it is written in the background.',
    description:
      'For staff who also hold `report.read`, `payment.read` and `partner.read` (403 otherwise). Answers 202 with the ' +
      'run id; the dashboard shows the briefing once it is written. A briefing run less than 15 minutes ago, a ' +
      'workspace without an AI limit, or one whose limit this month is used, is a 409 and nothing is queued.',
    response: askResponseSchema,
    errors: [409],
  })
  @RequirePermission('ai.use')
  @Post('dashboard/briefing')
  @HttpCode(202)
  async refreshBriefing(@CurrentUser() auth: TenantAuth): Promise<{ id: string }> {
    const { runId } = await this.briefings.refresh(auth);
    return { id: runId };
  }

  @ApiDoc({
    summary: 'Dismiss a suggestion of the briefing for the whole workspace, for 14 days.',
    description:
      'For staff holding `report.read`, `payment.read` and `partner.read` (403 otherwise). No briefing stores or ' +
      'shows the same suggestion, the same kind on the same records, for 14 days; dismissing it again starts them over.',
    errors: [400, 404],
  })
  @RequirePermission('report.read')
  @Post('dashboard/suggestions/:id/dismiss')
  @HttpCode(204)
  async dismissSuggestion(@CurrentUser() auth: TenantAuth, @Param('id', idParam) id: string): Promise<void> {
    await this.briefings.dismiss(auth, id);
  }
}
