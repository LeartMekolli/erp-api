import Anthropic from '@anthropic-ai/sdk';
import { aiModel } from './ai-models';
import type { AiContent, AiMessage, AiProvider, AiRequest, AiResponse } from './ai-provider';

/**
 * Claude through Anthropic's Messages API. Never called by a test: they use `FakeAiProvider`, and the
 * request building below is tested as pure functions.
 *
 * Thinking blocks (always on for the 5.5 models) go back unchanged, and nothing earlier in a run's
 * conversation is ever rewritten, system prompt included: a thinking block is only valid in the exact
 * conversation that produced it.
 */
export class ClaudeAiProvider implements AiProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    const message = await this.client.messages.create(toParams(request));
    return {
      content: fromBlocks(message.content),
      stopReason: stopReasonOf(message.stop_reason),
      usage: usageOf(message.usage),
    };
  }
}

/** A call's tokens, and the web searches it made when it made any. */
export function usageOf(usage: Anthropic.Usage): AiResponse['usage'] {
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(searches > 0 ? { webSearches: searches } : {}),
  };
}

/**
 * The request for one call. A model that refuses a forced tool is asked for it in a text block after the
 * last user message instead; a forced call is always a run's last, so nothing later replays that text.
 */
export function toParams(request: AiRequest): Anthropic.MessageCreateParamsNonStreaming {
  const forcing = request.forceTool !== undefined;
  const forced = forcing && aiModel(request.model).forcedToolChoice;
  const messages = request.messages.map(toParam);
  if (forcing && !forced) {
    const last = messages.at(-1);
    if (last?.role === 'user') {
      const content = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content;
      messages[messages.length - 1] = {
        role: 'user',
        content: [...content, { type: 'text', text: `Finish by calling the ${request.forceTool} tool.` }],
      };
    }
  }

  const tools: Anthropic.ToolUnion[] = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: { ...tool.inputSchema, type: 'object' },
  }));
  if (request.webSearch) {
    tools.push({ type: aiModel(request.model).webSearchTool, name: 'web_search', max_uses: request.webSearch.maxUses });
  }

  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages,
    tools,
    ...(forcing ? { tool_choice: forced ? { type: 'tool' as const, name: request.forceTool! } : { type: 'auto' as const } } : {}),
  };
}

/**
 * A response's blocks: text and tool calls; thinking, and every block of Claude's own tools (a search,
 * its results with the URLs found), kept opaque to be passed back as they came.
 */
export function fromBlocks(blocks: Anthropic.ContentBlock[]): AiContent[] {
  return blocks.map((block): AiContent => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'tool_use') {
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      return { type: 'reasoning', raw: block };
    }
    if (block.type === 'web_search_tool_result') {
      // A failed search's content is one error object, not a list.
      return { type: 'web_results', urls: Array.isArray(block.content) ? block.content.map((result) => result.url) : [], raw: block };
    }
    return { type: 'server_tool', raw: block };
  });
}

function toParam(message: AiMessage): Anthropic.MessageParam {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content.map((block): Anthropic.ContentBlockParam => {
        if (block.type === 'text') return { type: 'text', text: block.text };
        if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        return block.raw as Anthropic.ContentBlockParam;
      }),
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

export function stopReasonOf(reason: Anthropic.StopReason | null): AiResponse['stopReason'] {
  switch (reason) {
    case 'tool_use':
    case 'refusal':
    case 'max_tokens':
    case 'pause_turn':
      return reason;
    case 'model_context_window_exceeded':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}
