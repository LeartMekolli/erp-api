import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AttentionService } from '../reporting/attention.service';
import { ReportsService } from '../reporting/reports.service';
import { ReportsModule } from '../reporting/reporting.module';
import { AI_PROVIDER } from './ai-provider';
import type { AiProvider } from './ai-provider';
import { AskService } from './ask.service';
import { ClaudeAiProvider } from './claude-ai-provider';
import { FakeAiProvider } from './fake-ai-provider';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { VECTOR_STORE } from './knowledge/vector-store';
import type { VectorStore } from './knowledge/vector-store';
import { RunHandler } from './run.handler';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { customerTools } from './tools/customers.tool';
import { invoiceTools } from './tools/invoices.tool';
import { knowledgeTools } from './tools/knowledge.tool';
import { orderTools } from './tools/orders.tool';
import { partnerTools } from './tools/partners.tool';
import { reportTools } from './tools/reports.tool';
import { AI_TOOLS } from './tools/tool';
import type { AiTool } from './tools/tool';

/** The staff AI: one gateway to Claude, runs within a monthly limit, Cmd+K and the briefing (AI spec). */
@Module({
  imports: [NotificationsModule, ReportsModule, KnowledgeModule],
  controllers: [RunsController, SearchController],
  providers: [
    SearchService,
    RunsService,
    RunHandler,
    AskService,
    {
      provide: AI_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AiProvider => {
        if (config.get('AI_PROVIDER') !== 'claude') {
          return new FakeAiProvider();
        }
        const apiKey = config.get('ANTHROPIC_API_KEY');
        if (apiKey === undefined) {
          throw new Error('ANTHROPIC_API_KEY is required when AI_PROVIDER is claude');
        }
        return new ClaudeAiProvider(apiKey);
      },
    },
    {
      // Read-only, each running as the asking user; offered only to someone holding its permissions.
      provide: AI_TOOLS,
      inject: [PrismaService, ReportsService, AttentionService, VECTOR_STORE],
      useFactory: (prisma: PrismaService, reports: ReportsService, attention: AttentionService, store: VectorStore): AiTool<unknown>[] => [
        ...orderTools(prisma),
        ...customerTools(prisma),
        ...partnerTools(prisma),
        ...invoiceTools(prisma),
        ...reportTools(reports, attention),
        ...knowledgeTools(prisma, store),
      ],
    },
  ],
  exports: [AI_PROVIDER, RunsService, AI_TOOLS, KnowledgeModule],
})
export class AiModule {}
