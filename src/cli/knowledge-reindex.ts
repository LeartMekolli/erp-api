import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { PrismaService } from '../database/prisma.service';
import { JobsModule } from '../jobs/jobs.module';
import { indexArticle } from '../modules/ai/knowledge/index.handler';
import { KnowledgeModule } from '../modules/ai/knowledge/knowledge.module';
import { VECTOR_STORE } from '../modules/ai/knowledge/vector-store';
import type { VectorStore } from '../modules/ai/knowledge/vector-store';
import { RedisModule } from '../redis/redis.module';
import { STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';
import { StorageModule } from '../storage/storage.module';
import { runCli } from './run-cli';

@Module({ imports: [ConfigModule, DatabaseModule, RedisModule, JobsModule, StorageModule, KnowledgeModule] })
class ReindexModule {}

// npm run knowledge:reindex
// Rebuilds the vector store from Postgres: every published article of every workspace, one at a time.
void runCli(async (app) => {
  const prisma = app.get(PrismaService);
  const storage = app.get<ObjectStorage>(STORAGE);
  const store = app.get<VectorStore>(VECTOR_STORE);
  let articles = 0;
  let passages = 0;
  for (const tenant of await prisma.tenant.findMany({ select: { id: true } })) {
    const ids = await prisma.inTenant(tenant.id, (tx) =>
      tx.knowledgeArticle.findMany({ where: { status: 'published' }, select: { id: true }, orderBy: { id: 'asc' } }),
    );
    for (const { id } of ids) {
      passages += await indexArticle(prisma, storage, store, tenant.id, id);
      articles += 1;
    }
  }
  process.stdout.write(`Indexed ${articles} articles in ${passages} passages.\n`);
}, ReindexModule);
