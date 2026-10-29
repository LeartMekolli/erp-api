import { z } from 'zod';
import type { AttentionService } from '../../reporting/attention.service';
import type { ReportsService } from '../../reporting/reports.service';
import { authOf } from './tool';
import type { AiTool, RecordRef } from './tool';

/**
 * The dashboard's numbers and attention list (`report.read`), filtered exactly as the dashboard filters
 * them for the asking user: no money figure without `payment.read`, no partner one without `partner.read`.
 */
export function reportTools(reports: ReportsService, attention: AttentionService): AiTool<unknown>[] {
  const dashboardNumbers: AiTool<Record<string, never>> = {
    name: 'dashboard_numbers',
    description:
      "This week against last week: orders, production (on-time rate, hours per step, defect rate), customers and partners. Weeks run from Monday in the workspace's time zone.",
    permissions: ['report.read'],
    input: z.strictObject({}),
    run: async (ctx) => {
      const numbers = await reports.dashboardNumbers(authOf(ctx));
      const refs: RecordRef[] = [];
      for (const week of [numbers.current, numbers.previous]) {
        for (const customer of [...week.customers.top, ...week.customers.ordering_less, ...(week.customers.slow_payers ?? [])]) {
          refs.push({ type: 'customer', id: customer.id });
        }
        for (const partner of [...(week.partners?.load ?? []), ...(week.partners?.on_time ?? [])]) {
          refs.push({ type: 'partner', id: partner.id });
        }
        for (const step of week.production.step_hours) refs.push({ type: 'step', id: step.step_type_id });
      }
      return { data: numbers, refs };
    },
  };

  const attentionList: AiTool<Record<string, never>> = {
    name: 'attention',
    description:
      'What needs attention now: orders at risk, overdue jobs and invoices, orders waiting for payment, nearly full partners, unanswered offers, a defect spike. Each kind with its total and first items.',
    permissions: ['report.read'],
    input: z.strictObject({}),
    run: async (ctx) => {
      const groups = await attention.list(authOf(ctx), new Date());
      return { data: groups, refs: groups.flatMap((group) => group.items.map((item) => item.ref)) };
    },
  };

  return [dashboardNumbers, attentionList] as AiTool<unknown>[];
}
