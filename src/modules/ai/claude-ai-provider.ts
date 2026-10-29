import Anthropic from '@anthropic-ai/sdk';
import { aiModel } from './ai-models';
import type { AiContent, AiMessage, AiProvider, AiRequest, AiResponse } from './ai-provider';

/**
 * Claude through Anthropic's Messages API. Never called by a test: they use `FakeAiProvider`.
 * Thinking blocks are not kept: Haiku 4.5, the default, does not think unless asked.
 */
export class ClaudeAiProvider implements AiProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    const forced = request.forceTool !== undefined && aiModel(request.model).forcedToolChoice;
    // A model that refuses a forced tool is told to call it instead.
    const system =
      request.forceTool !== undefined && !forced
        ? `${request.system}\n\nFinish by calling the ${request.forceTool} tool.`
        : request.system;

    const message = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system,
      messages: request.messages.map(toParam),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: { ...tool.inputSchema, type: 'object' },
      })),
      ...(request.forceTool === undefined
        ? {}
        : { tool_choice: forced ? { type: 'tool' as const, name: request.forceTool } : { type: 'auto' as const } }),
    });

    return {
      content: message.content.flatMap((block): AiContent[] => {
        if (block.type === 'text') {
          return [{ type: 'text', text: block.text }];
        }
        if (block.type === 'tool_use') {
          return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }];
        }
        return [];
      }),
      stopReason: stopReasonOf(message.stop_reason),
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
  }
}

function toParam(message: AiMessage): Anthropic.MessageParam {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content.map((block) =>
        block.type === 'text'
          ? { type: 'text', text: block.text }
          : { type: 'tool_use', id: block.id, name: block.name, input: block.input },
      ),
    };
  }
  if (typeof message.content === 'string') {
    return { role: 'user', content: message.content };
  }
  return {
    role: 'user',
    content: message.content.map((result) => ({
      type: 'tool_result',
      tool_use_id: result.toolUseId,
      content: result.content,
    })),
  };
}

function stopReasonOf(reason: Anthropic.StopReason | null): AiResponse['stopReason'] {
  switch (reason) {
    case 'tool_use':
    case 'refusal':
    case 'max_tokens':
      return reason;
    case 'model_context_window_exceeded':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}
