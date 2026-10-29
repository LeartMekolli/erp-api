import { Controller, Get } from '@nestjs/common';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { AttentionService } from './attention.service';
import { dashboardResponseSchema } from './dashboard-response';
import type { DashboardResponse } from './dashboard-response';
import { ReportsService } from './reports.service';

/** The staff dashboard (AI 1 spec, goals 5–7). */
@Controller('reports')
export class DashboardController {
  constructor(
    private readonly reports: ReportsService,
    private readonly attention: AttentionService,
  ) {}

  @ApiDoc({
    summary: 'This week against last week, and what needs attention now.',
    description:
      "Weeks run from Monday in the workspace's time zone and are computed every 15 minutes. Money figures need " +
      '`payment.read` and partner figures `partner.read`; without them they are left out, never zeroed. `attention` is ' +
      'live: each kind follows the permission of the list it comes from, with its total and at most 20 items.',
    response: dashboardResponseSchema,
    errors: [],
  })
  @RequirePermission('report.read')
  @Get('dashboard')
  async dashboard(@CurrentUser() auth: TenantAuth): Promise<DashboardResponse> {
    const numbers = await this.reports.dashboardNumbers(auth);
    return { ...numbers, attention: await this.attention.list(auth, new Date()) };
  }
}
