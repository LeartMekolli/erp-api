import { Controller, Get } from '@nestjs/common';
import { ApiDoc } from '../../docs/api-doc';
import { CurrentUser } from '../identity/auth-context';
import type { TenantAuth } from '../identity/auth-context';
import { RequirePermission } from '../identity/route-markers';
import { dashboardResponseSchema } from './dashboard-response';
import type { DashboardResponse } from './dashboard-response';
import { ReportsService } from './reports.service';

/** The staff dashboard (AI 1 spec, goals 5–7). */
@Controller('reports')
export class DashboardController {
  constructor(private readonly reports: ReportsService) {}

  @ApiDoc({
    summary: 'This week against last week, as computed every 15 minutes.',
    description:
      "Weeks run from Monday in the workspace's time zone. Money figures need `payment.read` and partner figures " +
      '`partner.read`; without them they are left out, never zeroed.',
    response: dashboardResponseSchema,
    errors: [],
  })
  @RequirePermission('report.read')
  @Get('dashboard')
  dashboard(@CurrentUser() auth: TenantAuth): Promise<DashboardResponse> {
    return this.reports.dashboardNumbers(auth);
  }
}
