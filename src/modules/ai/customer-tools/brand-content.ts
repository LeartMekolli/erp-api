import { ConflictException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { visibleTo } from '../../catalog/visibility';
import { PortalCatalogService } from '../../customers/portal-catalog.service';
import type { CustomerAuth } from '../../identity/auth-context';
import { AI_PROVIDER } from '../ai-provider';
import type { AiProvider } from '../ai-provider';
import { runTools } from '../ask';
import type { FinalTool } from '../ask';
import type { RunOutcome } from '../runs.service';
import { BrandProfileService, describeProfile } from './brand-profile.service';
import { customerSystemFor, tagged } from './customer-prompt';
import { brandContentOutputSchema } from './customer-result-response';
import type { BrandContentBody, BrandContentOutput } from './customer-result-response';
import type { CustomerRun } from './customer-tools';
import { CustomerToolsService } from './customer-tools.service';

const TASK = [
  'Write catalog text for one product in the tone of the brand profile: up to 3 name ideas, a short description,',
  'a long description and tags. Describe only what the product text states; never invent a material, size or price.',
].join(' ');

export const BRAND_CONTENT_TOOL: FinalTool<BrandContentOutput> = {
  name: 'brand_content',
  description: 'Give the catalog text: up to 3 names, a short and a long description, and tags.',
  input: brandContentOutputSchema,
  check: (output) => output,
};

/** Brand content (AI 2 spec, goal 12): catalog text for a product, written from the brand profile. */
@Injectable()
export class BrandContentService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: CustomerToolsService,
    private readonly profiles: BrandProfileService,
    private readonly catalog: PortalCatalogService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  onModuleInit(): void {
    this.tools.onKind('brand_content', (run) => this.write(run));
  }

  /** Needs a brand profile (409) and, if given, a product the customer can see (404); neither is charged. */
  start(customer: CustomerAuth, body: BrandContentBody): Promise<{ id: string }> {
    return this.tools.start(customer, 'brand_content', body, {
      check: async (tx) => {
        if (body.product_id) {
          const product = await tx.product.findFirst({ where: { id: body.product_id, ...visibleTo(customer.customerId) }, select: { id: true } });
          if (!product) throw new NotFoundException('Product not found');
        }
        if (!(await this.profiles.of(tx, customer.customerId))) throw new ConflictException('Fill in the brand profile first');
      },
    });
  }

  private async write(run: CustomerRun): Promise<RunOutcome> {
    const input = run.run.input as { product_id?: string; description?: string };
    const { system, profile } = await this.prisma.inTenant(run.tenantId, async (tx) => ({
      system: await customerSystemFor(tx, TASK),
      profile: await this.profiles.of(tx, run.customerId),
    }));
    if (!profile) throw new Error('Brand content without a brand profile');
    return runTools(this.provider, {
      model: run.run.model,
      system,
      question: [
        tagged('brand_profile', describeProfile(profile)),
        tagged('customer_input', await this.about(run, input)),
        'Write the catalog text for this product.',
      ].join('\n\n'),
      tools: [],
      ctx: this.tools.customerCtx(run),
      final: BRAND_CONTENT_TOOL,
    });
  }

  /** The product as the customer's portal shows it, or the customer's own description. */
  private async about(run: CustomerRun, input: { product_id?: string; description?: string }): Promise<string> {
    if (!input.product_id) return input.description ?? '';
    const auth: CustomerAuth = { tenantId: run.tenantId, userId: run.userId, customerId: run.customerId, role: 'viewer' };
    const product = (await this.catalog.list(auth)).data.find((one) => one.id === input.product_id);
    if (!product) throw new Error('The product is no longer in the catalog');
    return JSON.stringify({
      name: product.name,
      kind: product.kind,
      options: product.options.map((option) => ({ name: option.name, values: option.values.map((value) => value.name) })),
      parts: product.parts,
    });
  }
}
