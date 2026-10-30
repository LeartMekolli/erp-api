import { Inject, Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { PrismaService } from '../../../database/prisma.service';
import { HandlesJob } from '../../../jobs/handles-job';
import type { JobHandler } from '../../../jobs/handles-job';
import { STORAGE } from '../../../storage/object-storage';
import type { ObjectStorage } from '../../../storage/object-storage';
import { READABLE_VERSIONS } from './articles.service';
import { toPassages } from './passages';
import { VECTOR_STORE, namespaceOf } from './vector-store';
import type { VectorStore } from './vector-store';

interface Payload {
  tenantId: string;
  articleId: string;
  version: string;
}

/** A stored object's whole body, read into memory. */
export async function bytesOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** The text of a PDF or plain text file. `unpdf` is an ES module, so it is loaded when first needed. */
export async function textOf(bytes: Buffer, contentType: string): Promise<string> {
  if (contentType === 'text/plain') return bytes.toString('utf8');
  if (contentType === 'application/pdf') {
    const { extractText } = await import('unpdf');
    return (await extractText(new Uint8Array(bytes), { mergePages: true })).text;
  }
  return '';
}

/**
 * Puts one article's passages in the vector store as the article reads now (JOBS['knowledge.index']):
 * a published one with its attachments' text, anything else removed. Safe to run again, and in any
 * order: it never trusts the version it was queued for.
 */
@Injectable()
@HandlesJob('knowledge.index')
export class KnowledgeIndexHandler implements JobHandler<Payload> {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
    @Inject(VECTOR_STORE) private readonly store: VectorStore,
  ) {}

  async handle(payload: Payload): Promise<void> {
    await indexArticle(this.prisma, this.storage, this.store, payload.tenantId, payload.articleId);
  }
}

/** Shared with `npm run knowledge:reindex`. */
export async function indexArticle(
  prisma: PrismaService,
  storage: ObjectStorage,
  store: VectorStore,
  tenantId: string,
  articleId: string,
): Promise<number> {
  const article = await prisma.inTenant(tenantId, (tx) =>
    tx.knowledgeArticle.findUnique({
      where: { id: articleId },
      select: {
        id: true,
        title: true,
        body: true,
        status: true,
        attachments: {
          orderBy: { position: 'asc' },
          select: {
            file: {
              select: {
                versions: {
                  where: { status: { in: READABLE_VERSIONS } },
                  orderBy: { number: 'desc' },
                  take: 1,
                  select: { storageKey: true, contentType: true },
                },
              },
            },
          },
        },
      },
    }),
  );
  const namespace = namespaceOf(tenantId);
  if (!article || article.status !== 'published') {
    await store.replaceArticle(namespace, articleId, []);
    return 0;
  }
  const texts: string[] = [];
  for (const { file } of article.attachments) {
    const version = file.versions[0];
    if (version) texts.push(await textOf(await bytesOf(await storage.read(version.storageKey)), version.contentType));
  }
  const passages = toPassages(article, texts);
  await store.replaceArticle(namespace, articleId, passages);
  return passages.length;
}
