import type { AiProvider, AiRequest, AiResponse } from './ai-provider';

const usage = { inputTokens: 100, outputTokens: 50 };
let nextCall = 0;

export function fakeText(text: string): AiResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage };
}

export function fakeToolUse(name: string, input: unknown, id = `fake_call_${++nextCall}`): AiResponse {
  return { content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use', usage };
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
