import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AI_PROVIDER } from './ai-provider';
import type { AiProvider } from './ai-provider';
import { ClaudeAiProvider } from './claude-ai-provider';
import { FakeAiProvider } from './fake-ai-provider';
import { RunHandler } from './run.handler';
import { RunsService } from './runs.service';

/** The staff AI: one gateway to Claude, runs within a monthly limit, Cmd+K and the briefing (AI spec). */
@Module({
  imports: [NotificationsModule],
  providers: [
    RunsService,
    RunHandler,
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
  ],
  exports: [AI_PROVIDER, RunsService],
})
export class AiModule {}
