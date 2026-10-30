import { ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { newId } from '../../../common/ids/uuid';
import { decodeCursor } from '../../../common/pagination/cursor';
import { toPage } from '../../../common/pagination/page';
import type { Page } from '../../../common/pagination/page';
import { ConfigService } from '../../../config/config.service';
import { PrismaService } from '../../../database/prisma.service';
import type { AiRun, Prisma } from '../../../generated/prisma/client';
import { JobsService } from '../../../jobs/jobs.service';
import { lockCustomer } from '../../customers/customers.service';
import { FilesService } from '../../files/files.service';
import type { CustomerAuth } from '../../identity/auth-context';
import { CreditsService } from '../../payments/credits/credits.service';
import { planOf } from '../../payments/plans/plan-of';
import { SettingsService } from '../../settings/settings.service';
import type { SettingValue } from '../../settings/setting-keys';
import { RunsService } from '../runs.service';
import type { RunOutcome } from '../runs.service';
import type { ToolContext } from '../tools/tool';
import { TOOL_OUTPUTS } from './customer-result-response';
import type { CustomerResultListQuery, CustomerResultResponse } from './customer-result-response';
import { CUSTOMER_FAILED_MESSAGE, CUSTOMER_TOOLS, DEFAULT_TOOL_PRICES, TOOL_FEATURE } from './customer-tools';
import type { CustomerRun, CustomerTool } from './customer-tools';

type Tx = Prisma.TransactionClient;

const include = {
  run: { select: { input: true, result: { select: { status: true, output: true, finishedAt: true } } } },
  spend: { select: { givenBack: { select: { id: true } } } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.AiCustomerResultInclude;

type ResultRow = Prisma.AiCustomerResultGetPayload<{ include: typeof include }>;

function toResponse(row: ResultRow): CustomerResultResponse {
  const result = row.run.result;
  const tool = row.tool as CustomerResultResponse['tool'];
  const stored = result?.status === 'done' && result.output !== null ? TOOL_OUTPUTS[tool].safeParse(result.output) : null;
  // The customer id is the route's; the run keeps it for its handler.
  const input = { ...(row.run.input as Record<string, unknown>) };
  delete input.customerId;
  // The output was parsed with the schema of this row's tool, so it is that tool's member.
  return {
    id: row.runId,
    tool,
    status: (result?.status ?? 'pending') as CustomerResultResponse['status'],
    input,
    output: stored?.success ? stored.data : null,
    credits: row.credits,
    credits_given_back: row.spend.givenBack !== null,
    error: result?.status === 'failed' ? CUSTOMER_FAILED_MESSAGE : null,
    parent_id: row.parentId,
    // Written as the image is stored, just before the run finishes; shown once it has.
    file_id: result?.status === 'done' ? row.fileId : null,
    asked_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    finished_at: result?.finishedAt.toISOString() ?? null,
  } as CustomerResultResponse;
}

/**
 * The customer AI tools' one way in (AI 2 spec, goals 1–7, 14–15): the plan switch, the price, the spend
 * and the run in one transaction, so a run never stands without its spend nor a spend without its run;
 * credits back by job when a run fails; and the customer's history of them.
 */
@Injectable()
export class CustomerToolsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly runs: RunsService,
    private readonly credits: CreditsService,
    private readonly settings: SettingsService,
    private readonly files: FilesService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    for (const tool of CUSTOMER_TOOLS) {
      this.runs.onFailed(tool, (tenantId, runId) => this.jobs.enqueue('ai.credits.give_back', { tenantId, runId }));
    }
  }

  /** Registers how runs of a tool are run, given the customer they are for. */
  onKind(tool: CustomerTool, handler: (run: CustomerRun) => Promise<RunOutcome>): void {
    this.runs.onKind(tool, async (tenantId, run) => handler(await this.customerRun(tenantId, run)));
  }

  /**
   * Charges the tool's price and queues its run. Locks the customer, then the AI limit (in `queueIn`).
   * Refused, writing nothing: 403 without the plan switch, 409 without enough credits or with the
   * month's AI limit used, or whatever `check` throws. The run's input is `payload` with the customer.
   */
  async start(
    customer: CustomerAuth,
    tool: CustomerTool,
    payload: object,
    options: { parentId?: string; check?: (tx: Tx) => Promise<void> } = {},
  ): Promise<{ id: string }> {
    const runId = newId();
    await this.prisma.inTenant(customer.tenantId, async (tx) => {
      await lockCustomer(tx, customer.customerId);
      if (!(await planOf(tx, customer.customerId)).features.has(TOOL_FEATURE[tool])) {
        throw new ForbiddenException("Your plan doesn't include this tool");
      }
      await options.check?.(tx);
      const credits = (await this.prices(tx))[tool];
      const { spendId } = await this.credits.spendIn(tx, customer.customerId, {
        amount: credits,
        reason: `ai.${tool}`,
        reference: `ai_run:${runId}`,
      });
      await this.runs.queueIn(tx, customer.tenantId, {
        id: runId,
        userId: customer.userId,
        kind: tool,
        payload: { customerId: customer.customerId, ...payload },
      });
      await tx.aiCustomerResult.create({
        data: { runId, customerId: customer.customerId, tool, credits, spendId, parentId: options.parentId, createdByUserId: customer.userId },
      });
    });
    try {
      await this.runs.enqueueRun(customer.tenantId, runId);
    } catch (error) {
      // Never left charged for a run that will not run: failing it gives the credits back.
      await this.runs.fail(customer.tenantId, runId, 'Not queued');
      throw error;
    }
    return { id: runId };
  }

  /** What a customer run's tools run as: no staff permission, so only the tools a handler builds for the customer. */
  customerCtx(run: CustomerRun): ToolContext {
    return { tenantId: run.tenantId, permissions: new Set(), userId: run.userId };
  }

  /** One of the customer's results; another customer's, or a deleted one, is a 404. */
  async get(customer: CustomerAuth, id: string): Promise<CustomerResultResponse> {
    return this.prisma.inTenant(customer.tenantId, async (tx) => {
      const row = await tx.aiCustomerResult.findFirst({ where: { runId: id, customerId: customer.customerId, deletedAt: null }, include });
      if (!row) throw new NotFoundException('Result not found');
      return toResponse(row);
    });
  }

  /** The customer's history, newest first, deleted ones left out. */
  async list(customer: CustomerAuth, query: CustomerResultListQuery): Promise<Page<CustomerResultResponse>> {
    const secret = this.config.get('APP_SECRET');
    const after = query.cursor ? decodeCursor(query.cursor, secret) : undefined;
    return this.prisma.inTenant(customer.tenantId, async (tx) => {
      const rows = await tx.aiCustomerResult.findMany({
        where: { customerId: customer.customerId, deletedAt: null, tool: query.tool, ...(after ? { runId: { lt: after.id } } : {}) },
        orderBy: { runId: 'desc' },
        take: query.limit + 1,
        include,
      });
      return toPage(rows.map(toResponse), query.limit, secret);
    });
  }

  /**
   * Hides a result from the history and removes its image's file. The run log and the credit ledger keep
   * their rows; no credits come back. A run still running is a 409.
   */
  async remove(customer: CustomerAuth, id: string): Promise<void> {
    const fileId = await this.prisma.inTenant(customer.tenantId, async (tx) => {
      const row = await tx.aiCustomerResult.findFirst({
        where: { runId: id, customerId: customer.customerId, deletedAt: null },
        select: { fileId: true, run: { select: { result: { select: { id: true } } } } },
      });
      if (!row) throw new NotFoundException('Result not found');
      if (!row.run.result) throw new ConflictException('Still running');
      const hidden = await tx.aiCustomerResult.updateMany({
        where: { runId: id, deletedAt: null },
        data: { deletedAt: new Date(), deletedByUserId: customer.userId },
      });
      if (hidden.count === 0) throw new NotFoundException('Result not found');
      return row.fileId;
    });
    if (fileId) await this.files.remove(customer.tenantId, fileId, { type: 'customer', id: customer.customerId });
  }

  /** The `ai.credits.give_back` job: the run's spend back, once. */
  async giveBack(tenantId: string, runId: string): Promise<void> {
    const row = await this.prisma.inTenant(tenantId, (tx) =>
      tx.aiCustomerResult.findUnique({ where: { runId }, select: { spendId: true } }),
    );
    if (!row) return;
    await this.credits.giveBack(tenantId, row.spendId);
  }

  private async prices(tx: Tx): Promise<Record<CustomerTool, number>> {
    const set = (await this.settings.list(tx))['ai.toolPrices'] as SettingValue<'ai.toolPrices'> | undefined;
    return set ?? DEFAULT_TOOL_PRICES;
  }

  private async customerRun(tenantId: string, run: AiRun): Promise<CustomerRun> {
    const row = await this.prisma.inTenant(tenantId, (tx) => tx.aiCustomerResult.findUniqueOrThrow({ where: { runId: run.id } }));
    return { tenantId, run, customerId: row.customerId, userId: row.createdByUserId, parentId: row.parentId };
  }
}
