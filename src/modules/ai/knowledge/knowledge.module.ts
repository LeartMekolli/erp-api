import { Module } from '@nestjs/common';
import { ConfigService } from '../../../config/config.service';
import { AuditModule } from '../../audit/audit.module';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { FakeVectorStore } from './fake-vector-store';
import { KnowledgeIndexHandler } from './index.handler';
import { PineconeVectorStore } from './pinecone-vector-store';
import { VECTOR_STORE } from './vector-store';
import type { VectorStore } from './vector-store';

/** The knowledge base (AI 1 spec, goals 14 and 15): articles in Postgres, their passages in the vector store. */
@Module({
  imports: [AuditModule],
  controllers: [ArticlesController],
  providers: [
    ArticlesService,
    KnowledgeIndexHandler,
    {
      provide: VECTOR_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): VectorStore => {
        if (config.get('VECTOR_STORE') !== 'pinecone') return new FakeVectorStore();
        const apiKey = config.get('PINECONE_API_KEY');
        const index = config.get('PINECONE_INDEX');
        if (apiKey === undefined || index === undefined) {
          throw new Error('PINECONE_API_KEY and PINECONE_INDEX are required when VECTOR_STORE is pinecone');
        }
        return new PineconeVectorStore(apiKey, index);
      },
    },
  ],
  exports: [ArticlesService, VECTOR_STORE],
})
export class KnowledgeModule {}
