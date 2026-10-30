import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { CustomerAuth } from '../../identity/auth-context';
import { AI_PROVIDER } from '../ai-provider';
import type { AiProvider } from '../ai-provider';
import { runTools } from '../ask';
import type { FinalTool } from '../ask';
import { MAX_WEB_SEARCHES } from '../extra-costs';
import type { RunOutcome } from '../runs.service';
import { BrandProfileService, describeProfile } from './brand-profile.service';
import { customerSystemFor, tagged } from './customer-prompt';
import { recommendationsOutputSchema } from './customer-result-response';
import type { RecommendationsBody, RecommendationsOutput } from './customer-result-response';
import type { CustomerRun } from './customer-tools';
import { CustomerToolsService } from './customer-tools.service';
import { customerFigures } from './marketing';

/**
 * Keeps only sources among `urls`, each once, then only items left with one (Review Focus 3). Every idea
 * may be dropped; the run then fails.
 */
export function checkSources(output: RecommendationsOutput, urls: ReadonlySet<string>): RecommendationsOutput {
  const found = (sources: string[]) => [...new Set(sources.filter((url) => urls.has(url)))];
  const sourced = <T extends { sources: string[] }>(items: T[]) =>
    items.map((item) => ({ ...item, sources: found(item.sources) })).filter((item) => item.sources.length > 0);
  return { ideas: sourced(output.ideas), advice: sourced(output.advice) };
}

const RECOMMENDATIONS_TOOL: FinalTool<RecommendationsOutput> = {
  name: 'recommendations',
  description:
    'Give about 5 product ideas and up to 3 pieces of general advice. Each lists in `sources` at least one URL of a page ' +
    'your web searches returned in this conversation; an item without one is dropped.',
  input: recommendationsOutputSchema,
  check: (output, _known, urls) => checkSources(output, urls),
};

const TASK = [
  "Suggest product ideas and general advice for the customer's range of made-to-order 3D objects, informed by current trends.",
  'Search the web for trends that fit the focus and the brand. Cite only pages your searches returned; never invent a link.',
].join(' ');

/** Recommendations (AI 2 spec, goal 10): product ideas and advice from web trends, with their sources. */
@Injectable()
export class RecommendationsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: CustomerToolsService,
    private readonly profiles: BrandProfileService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  onModuleInit(): void {
    this.tools.onKind('recommendations', (run) => this.recommend(run));
  }

  start(customer: CustomerAuth, body: RecommendationsBody): Promise<{ id: string }> {
    return this.tools.start(customer, 'recommendations', body);
  }

  private async recommend(run: CustomerRun): Promise<RunOutcome> {
    const input = run.run.input as { focus?: string };
    const { system, figures, profile } = await this.prisma.inTenant(run.tenantId, async (tx) => ({
      system: await customerSystemFor(tx, TASK),
      figures: await customerFigures(tx, run.customerId, new Date()),
      profile: await this.profiles.of(tx, run.customerId),
    }));
    const topProducts = figures.filter((figure) => figure.key.startsWith('top_product_')).map((figure) => figure.value);
    const outcome = await runTools(this.provider, {
      model: run.run.model,
      system,
      question: [
        ...(profile ? [tagged('brand_profile', describeProfile(profile))] : []),
        tagged('customer_input', JSON.stringify({ focus: input.focus ?? null, most_ordered_last_90_days: topProducts })),
        'Give the recommendations.',
      ].join('\n\n'),
      tools: [],
      ctx: this.tools.customerCtx(run),
      final: RECOMMENDATIONS_TOOL,
      webSearch: { maxUses: MAX_WEB_SEARCHES },
    });
    // No idea left with a source: nothing to show, so the credits come back.
    if (outcome.status === 'done' && (outcome.output as RecommendationsOutput).ideas.length === 0) {
      return { ...outcome, status: 'failed', output: null, error: 'No idea cited a page the searches found' };
    }
    return outcome;
  }
}
