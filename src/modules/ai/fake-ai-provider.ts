import type { AiProvider, AiRequest, AiResponse } from './ai-provider';

const usage = { inputTokens: 100, outputTokens: 50 };
let nextCall = 0;

export function fakeText(text: string): AiResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage };
}

export function fakeToolUse(name: string, input: unknown, id = `fake_call_${++nextCall}`): AiResponse {
  return { content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use', usage };
}

/**
 * One web search that found `urls`, as a turn the provider paused after its own tool: the run sends it
 * back and the next scripted response continues it.
 */
export function fakeWebSearch(urls: string[], id = `fake_search_${++nextCall}`): AiResponse {
  return {
    content: [
      { type: 'server_tool', raw: { type: 'server_tool_use', id, name: 'web_search', input: { query: 'trends' } } },
      {
        type: 'web_results',
        urls,
        raw: {
          type: 'web_search_tool_result',
          tool_use_id: id,
          content: urls.map((url) => ({ type: 'web_search_result', url, title: url, encrypted_content: '', page_age: null })),
        },
      },
    ],
    stopReason: 'pause_turn',
    usage: { ...usage, webSearches: 1 },
  };
}

/** In memory, for local work and tests: returns what a test scripted, in order, and records every request. */
export class FakeAiProvider implements AiProvider {
  readonly calls: AiRequest[] = [];
  private readonly queue: AiResponse[] = [];

  script(...responses: AiResponse[]): void {
    this.queue.push(...responses);
  }

  complete(request: AiRequest): Promise<AiResponse> {
    this.calls.push(request);
    const response = this.queue.shift();
    if (!response) {
      return Promise.reject(new Error('FakeAiProvider: nothing scripted'));
    }
    return Promise.resolve(response);
  }
}
