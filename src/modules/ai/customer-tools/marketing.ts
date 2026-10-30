import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../../database/prisma.service';
import { Prisma } from '../../../generated/prisma/client';
import type { CustomerAuth } from '../../identity/auth-context';
import { AI_PROVIDER } from '../ai-provider';
import type { AiProvider } from '../ai-provider';
import { runTools } from '../ask';
import type { FinalTool } from '../ask';
import type { RunOutcome } from '../runs.service';
import { BrandProfileService, describeProfile } from './brand-profile.service';
import { customerSystemFor, tagged } from './customer-prompt';
import type { Figure } from './customer-result-response';
import type { CustomerRun } from './customer-tools';
import { CustomerToolsService } from './customer-tools.service';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90;
const TOP_PRODUCTS = 3;

const cardSchema = z.strictObject({
  title: z.string().max(80),
  advice: z.string().max(600),
  figures: z.array(z.string()).min(1).max(4),
});
type Card = z.infer<typeof cardSchema>;

const insightsSchema = z.strictObject({ cards: z.array(cardSchema).min(1).max(4) });
type Insights = z.infer<typeof insightsSchema>;

/** Keeps only figure keys in `keys`, each once, then only cards left with one (Review Focus 3). */
export function checkCards(cards: Card[], keys: ReadonlySet<string>): Card[] {
  return cards
    .map((card) => ({ ...card, figures: [...new Set(card.figures.filter((key) => keys.has(key)))] }))
    .filter((card) => card.figures.length > 0);
}

function insightsTool(keys: ReadonlySet<string>): FinalTool<Insights> {
  return {
    name: 'insights',
    description: 'Give the advice cards. Each cites in `figures` the keys of the figures it uses, only from the figures given.',
    input: insightsSchema,
    check: (output) => ({ cards: checkCards(output.cards, keys) }),
  };
}

/** Sums of order totals, by currency: "120.00 EUR", or "120.00 EUR + 30.00 USD". */
function money(orders: { total: Prisma.Decimal; currency: string }[], fallbackCurrency: string): string {
  const sums = new Map<string, Prisma.Decimal>();
  for (const order of orders) sums.set(order.currency, (sums.get(order.currency) ?? new Prisma.Decimal(0)).add(order.total));
  if (sums.size === 0) return `0.00 ${fallbackCurrency}`;
  return [...sums].map(([currency, sum]) => `${sum.toFixed(2)} ${currency}`).join(' + ');
}

/**
 * The customer's own figures over the 90 days before `at` and the 90 before those, cancelled orders left
 * out (AI 2 spec, goal 11). Nothing about other customers, partners, costs or margins.
 */
export async function customerFigures(tx: Prisma.TransactionClient, customerId: string, at: Date): Promise<Figure[]> {
  const start = new Date(at.getTime() - WINDOW_DAYS * DAY_MS);
  const previousStart = new Date(start.getTime() - WINDOW_DAYS * DAY_MS);
  const { defaultCurrency } = await tx.tenant.findFirstOrThrow({ select: { defaultCurrency: true } });
  const orders = await tx.order.findMany({
    where: { customerId, cancelledAt: null, placedAt: { gte: previousStart, lt: at } },
    select: { placedAt: true, total: true, currency: true },
  });
  const recent = orders.filter((order) => order.placedAt >= start);
  const previous = orders.filter((order) => order.placedAt < start);

  const figures: Figure[] = [
    { key: 'orders_90d', label: 'Orders in the last 90 days', value: String(recent.length) },
    { key: 'spend_90d', label: 'Spend in the last 90 days', value: money(recent, defaultCurrency) },
  ];
  const currencies = new Set(recent.map((order) => order.currency));
  if (recent.length > 0 && currencies.size === 1) {
    const sum = recent.reduce((total, order) => total.add(order.total), new Prisma.Decimal(0));
    figures.push({ key: 'average_order_90d', label: 'Average order in the last 90 days', value: `${sum.div(recent.length).toFixed(2)} ${[...currencies][0]}` });
  }
  figures.push(
    { key: 'orders_prev_90d', label: 'Orders in the 90 days before', value: String(previous.length) },
    { key: 'spend_prev_90d', label: 'Spend in the 90 days before', value: money(previous, defaultCurrency) },
  );

  const top = await tx.orderLine.groupBy({
    by: ['productId'],
    where: { cancelledAt: null, order: { customerId, cancelledAt: null, placedAt: { gte: start, lt: at } } },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: 'desc' } },
    take: TOP_PRODUCTS,
  });
  const names = new Map(
    (await tx.product.findMany({ where: { id: { in: top.map((one) => one.productId) } }, select: { id: true, name: true } })).map((product) => [
      product.id,
      product.name,
    ]),
  );
  top.forEach((one, index) => {
    figures.push({
      key: `top_product_${index + 1}`,
      label: `Most ordered product no. ${index + 1} in the last 90 days`,
      value: `${names.get(one.productId) ?? 'A product'} (${one._sum.quantity ?? 0} pieces)`,
    });
  });

  const last = await tx.order.findFirst({ where: { customerId, cancelledAt: null }, orderBy: { placedAt: 'desc' }, select: { placedAt: true } });
  if (last) figures.push({ key: 'last_order_on', label: 'Last order placed on', value: last.placedAt.toISOString().slice(0, 10) });
  return figures;
}

const TASK = [
  'Give 4 advice cards on how the customer could market its products and grow its orders, from its own figures.',
  'Each card cites in `figures` the keys of the figures it uses. Never state a number that is not among the figures given.',
].join(' ');

/** Marketing insights (AI 2 spec, goal 11): advice cards from the customer's own orders and spend. */
@Injectable()
export class MarketingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: CustomerToolsService,
    private readonly profiles: BrandProfileService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  onModuleInit(): void {
    this.tools.onKind('marketing', (run) => this.advise(run));
  }

  start(customer: CustomerAuth): Promise<{ id: string }> {
    return this.tools.start(customer, 'marketing', {});
  }

  /** The figures are read when the run runs. A run whose every card cited none fails, so its credits come back. */
  private async advise(run: CustomerRun): Promise<RunOutcome> {
    const { system, figures, profile } = await this.prisma.inTenant(run.tenantId, async (tx) => ({
      system: await customerSystemFor(tx, TASK),
      figures: await customerFigures(tx, run.customerId, new Date()),
      profile: await this.profiles.of(tx, run.customerId),
    }));
    const outcome = await runTools(this.provider, {
      model: run.run.model,
      system,
      question: [
        ...(profile ? [tagged('brand_profile', describeProfile(profile))] : []),
        tagged('customer_input', JSON.stringify(figures)),
        'Give the advice cards.',
      ].join('\n\n'),
      tools: [],
      ctx: this.tools.customerCtx(run),
      final: insightsTool(new Set(figures.map((figure) => figure.key))),
    });
    if (outcome.status !== 'done') return outcome;
    const { cards } = outcome.output as Insights;
    if (cards.length === 0) return { ...outcome, status: 'failed', output: null, error: 'No card cited a figure of the run' };
    const byKey = new Map(figures.map((figure) => [figure.key, figure]));
    return { ...outcome, output: { cards: cards.map((card) => ({ ...card, figures: card.figures.flatMap((key) => byKey.get(key) ?? []) })) } };
  }
}
