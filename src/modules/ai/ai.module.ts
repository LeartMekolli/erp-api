import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { CustomersModule } from '../customers/customers.module';
import { FilesModule } from '../files/files.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { SettingsModule } from '../settings/settings.module';
import { AttentionService } from '../reporting/attention.service';
import { DashboardController } from '../reporting/dashboard.controller';
import { ReportsService } from '../reporting/reports.service';
import { ReportsModule } from '../reporting/reporting.module';
import { AI_PROVIDER } from './ai-provider';
import type { AiProvider } from './ai-provider';
import { AskService } from './ask.service';
import { BriefingHandler } from './briefing.handler';
import { BriefingService } from './briefing.service';
import { ClaudeAiProvider } from './claude-ai-provider';
import { BrandContentService } from './customer-tools/brand-content';
import { BrandProfileController } from './customer-tools/brand-profile.controller';
import { BrandProfileService } from './customer-tools/brand-profile.service';
import { CustomerToolsController } from './customer-tools/customer-tools.controller';
import { CustomerToolsService } from './customer-tools/customer-tools.service';
import { MarketingService } from './customer-tools/marketing';
import { FakeAiProvider } from './fake-ai-provider';
import { FakeImageProvider } from './fake-image-provider';
import { GiveBackHandler } from './give-back.handler';
import { IMAGE_PROVIDER } from './image-provider';
import type { ImageProvider } from './image-provider';
import { OpenAiImageProvider } from './openai-image-provider';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { LimitCheckHandler } from './limit-check.handler';
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

/**
 * The AI: one gateway to Claude, runs within a monthly limit, Cmd+K and the briefing for staff (AI 1 spec),
 * and the customer tools paid in credits (AI 2 spec).
 */
@Module({
  imports: [NotificationsModule, ReportsModule, KnowledgeModule, PaymentsModule, FilesModule, SettingsModule, AuditModule, CustomersModule],
  // The dashboard's controller lives here: it shows the briefing, and this module imports ReportsModule.
  controllers: [RunsController, SearchController, DashboardController, CustomerToolsController, BrandProfileController],
  providers: [
    CustomerToolsService,
    BrandProfileService,
    BrandContentService,
    MarketingService,
    GiveBackHandler,
    SearchService,
    RunsService,
    RunHandler,
    LimitCheckHandler,
    AskService,
    BriefingService,
    BriefingHandler,
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
      provide: IMAGE_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ImageProvider => {
        if (config.get('IMAGE_PROVIDER') !== 'openai') {
          return new FakeImageProvider();
        }
        const apiKey = config.get('OPENAI_API_KEY');
        if (apiKey === undefined) {
          throw new Error('OPENAI_API_KEY is required when IMAGE_PROVIDER is openai');
        }
        return new OpenAiImageProvider(apiKey);
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
  exports: [AI_PROVIDER, IMAGE_PROVIDER, RunsService, AI_TOOLS, KnowledgeModule, CustomerToolsService],
})
export class AiModule {}
