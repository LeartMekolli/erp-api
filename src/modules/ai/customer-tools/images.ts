import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { ConfigService } from '../../../config/config.service';
import { PrismaService } from '../../../database/prisma.service';
import { Prisma } from '../../../generated/prisma/client';
import { STORAGE } from '../../../storage/object-storage';
import type { ObjectStorage } from '../../../storage/object-storage';
import { FilesService } from '../../files/files.service';
import type { CustomerAuth } from '../../identity/auth-context';
import { AI_PROVIDER } from '../ai-provider';
import type { AiProvider } from '../ai-provider';
import { runTools } from '../ask';
import type { FinalTool } from '../ask';
import { imageCost } from '../extra-costs';
import { IMAGE_PROVIDER } from '../image-provider';
import type { ImageProvider, ImageResult } from '../image-provider';
import { bytesOf } from '../knowledge/index.handler';
import type { RunOutcome } from '../runs.service';
import { BrandProfileService, describeProfile } from './brand-profile.service';
import { customerSystemFor, tagged } from './customer-prompt';
import { imageOutputSchema } from './customer-result-response';
import type { ImagesBody } from './customer-result-response';
import type { CustomerRun } from './customer-tools';
import { CustomerToolsService } from './customer-tools.service';

/** What every image prompt ends with, so the image can become a 3D model (AI 2 spec, goal 13). */
export const FOR_3D =
  'One single object, centred and shown whole, on a plain light background, in soft even studio light. No scene, no text, no people, no other objects.';

/** The prompt the image model gets: whatever was written, then the 3D rules, always last. */
export function imagePrompt(written: string): string {
  return `${written}\n\n${FOR_3D}`;
}

const imagePromptSchema = z.strictObject({ prompt: z.string().min(1).max(1000) });
type ImagePrompt = z.infer<typeof imagePromptSchema>;

const IMAGE_PROMPT_TOOL: FinalTool<ImagePrompt> = {
  name: 'image_prompt',
  description: 'Give the prompt for the image model: a plain description of the one object to show.',
  input: imagePromptSchema,
  check: (output) => output,
};

const TASK = [
  'Write the prompt for an image model: a concept image of one object that will become a 3D model.',
  "Describe only the object itself (its shape, material, finish and details) from the customer's description,",
  'in the spirit of the brand profile when there is one. Never describe a scene, people, text or other objects.',
].join(' ');

/** Images (AI 2 spec, goal 13 and Settled): Claude writes the prompt, the image model makes it, made for 3D. */
@Injectable()
export class ImagesService implements OnModuleInit {
  private readonly logger = new Logger(ImagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly tools: CustomerToolsService,
    private readonly profiles: BrandProfileService,
    private readonly files: FilesService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @Inject(IMAGE_PROVIDER) private readonly images: ImageProvider,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
  ) {}

  onModuleInit(): void {
    this.tools.onKind('image', (run) => this.make(run));
  }

  /**
   * A new image, or with `from_id` a refinement of an image of this customer's: 404 for one it doesn't
   * have, 409 for a deleted one or one not finished. Neither is charged.
   */
  start(customer: CustomerAuth, body: ImagesBody): Promise<{ id: string }> {
    const fromId = body.from_id;
    return this.tools.start(customer, 'image', body, {
      parentId: fromId,
      check: async (tx) => {
        if (!fromId) return;
        const parent = await tx.aiCustomerResult.findFirst({
          where: { runId: fromId, customerId: customer.customerId, tool: 'image' },
          select: { deletedAt: true, fileId: true, run: { select: { result: { select: { status: true } } } } },
        });
        if (!parent) throw new NotFoundException('Image not found');
        if (parent.deletedAt) throw new ConflictException('Image deleted');
        if (parent.run.result?.status !== 'done' || !parent.fileId) throw new ConflictException('Not finished');
      },
    });
  }

  /**
   * Claude writes the prompt, then the image model makes it; for a refinement, from the parent's bytes. An
   * image provider that fails ends the run failed with Claude's tokens only (Review Focus 5); an image
   * made but not stored ends it failed with the image's cost too.
   */
  private async make(run: CustomerRun): Promise<RunOutcome> {
    const input = run.run.input as { description: string };
    const parentId = run.parentId;
    const { system, profile, parent } = await this.prisma.inTenant(run.tenantId, async (tx) => ({
      system: await customerSystemFor(tx, TASK),
      profile: await this.profiles.of(tx, run.customerId),
      parent: parentId ? await this.parentOf(tx, parentId) : null,
    }));
    const outcome = await runTools(this.provider, {
      model: run.run.model,
      system,
      question: [
        ...(profile ? [tagged('brand_profile', describeProfile(profile))] : []),
        tagged('customer_input', parent ? JSON.stringify({ change: input.description, image_made_from: parent.prompt }) : input.description),
        parent ? 'Write the prompt for the image with this change.' : 'Write the image prompt.',
      ].join('\n\n'),
      tools: [],
      ctx: this.tools.customerCtx(run),
      final: IMAGE_PROMPT_TOOL,
    });
    if (outcome.status !== 'done') return outcome;

    const written = (outcome.output as ImagePrompt).prompt;
    const source = parent ? await bytesOf(await this.storage.read(parent.storageKey)) : undefined;
    const model = this.config.get('IMAGE_MODEL');
    let made: ImageResult;
    try {
      made = await this.images.create({ model, prompt: imagePrompt(written), ...(source ? { source } : {}) });
    } catch (error) {
      this.logger.warn({ err: error, runId: run.run.id }, 'the image provider failed');
      return { ...outcome, status: 'failed', output: null, error: 'The image could not be made' };
    }

    // Paid for from here on: a failure ends the run with the image's cost, never starts it over.
    const extraCostUsd = (outcome.extraCostUsd ?? new Prisma.Decimal(0)).add(imageCost(model));
    const fileId = run.run.id;
    try {
      await this.files.storeGenerated(run.tenantId, {
        fileId,
        owner: { type: 'customer', id: run.customerId },
        name: `ai-image-${fileId}.png`,
        bytes: made.bytes,
        contentType: made.contentType,
        createdByUserId: run.userId,
      });
      await this.prisma.inTenant(run.tenantId, (tx) => tx.aiCustomerResult.update({ where: { runId: run.run.id }, data: { fileId } }));
    } catch (error) {
      this.logger.warn({ err: error, runId: run.run.id }, 'the image could not be stored');
      return { ...outcome, status: 'failed', output: null, error: 'The image could not be stored', extraCostUsd };
    }
    return { ...outcome, output: { prompt: written, file_id: fileId }, extraCostUsd };
  }

  /** The image a refinement starts from: its stored prompt and bytes. Gone since it was asked for: the run fails. */
  private async parentOf(tx: Prisma.TransactionClient, runId: string): Promise<{ prompt: string; storageKey: string }> {
    const row = await tx.aiCustomerResult.findUniqueOrThrow({
      where: { runId },
      select: { fileId: true, run: { select: { result: { select: { output: true } } } } },
    });
    const stored = imageOutputSchema.safeParse(row.run.result?.output);
    const version = row.fileId
      ? await tx.fileVersion.findFirst({ where: { fileId: row.fileId, number: 1, file: { status: 'active' } }, select: { storageKey: true } })
      : null;
    if (!stored.success || !version) throw new Error('The image a refinement starts from is gone');
    return { prompt: stored.data.prompt, storageKey: version.storageKey };
  }
}
