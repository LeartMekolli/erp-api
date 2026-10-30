import type Anthropic from '@anthropic-ai/sdk';
import type { AiMessage, AiRequest } from './ai-provider';
import { fromBlocks, stopReasonOf, toParams, usageOf } from './claude-ai-provider';

const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' } as Anthropic.ContentBlock;
const redacted = { type: 'redacted_thinking', data: 'opaque-data' } as Anthropic.ContentBlock;
const toolUse = { type: 'tool_use', id: 'call_1', name: 'find_orders', input: { late: true } } as Anthropic.ContentBlock;

/** A run on its second turn: the question, the model's tool call (with its thinking), the tool's result. */
function secondTurn(model: string, forceTool?: string): AiRequest {
  const messages: AiMessage[] = [
    { role: 'user', content: 'Which orders are late?' },
    { role: 'assistant', content: fromBlocks([thinking, redacted, toolUse]) },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: '[]' }] },
  ];
  return {
    model,
    system: 'Answer from tool results.',
    messages,
    tools: [{ name: 'answer', description: 'Answer.', inputSchema: { type: 'object' } }],
    maxTokens: 2_000,
    ...(forceTool ? { forceTool } : {}),
  };
}

/** The Claude provider's request building (AI 1 review fixes, Task 3); no test calls Anthropic. */
describe('ClaudeAiProvider requests', () => {
  it('passes thinking and redacted thinking blocks back exactly as they came', () => {
    const params = toParams(secondTurn('claude-opus-5-5'));

    expect(params.messages[1]).toEqual({
      role: 'assistant',
      content: [thinking, redacted, { type: 'tool_use', id: 'call_1', name: 'find_orders', input: { late: true } }],
    });
  });

  it('forces the final tool on a model that allows it, leaving the conversation as it is', () => {
    const params = toParams(secondTurn('claude-haiku-4-5', 'answer'));

    expect(params.tool_choice).toEqual({ type: 'tool', name: 'answer' });
    expect(params.system).toBe('Answer from tool results.');
    expect(params.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '[]' }] });
  });

  it('on a model that refuses a forced tool, asks for it after the tool results and never changes the system prompt', () => {
    const before = toParams(secondTurn('claude-opus-5-5'));
    const forced = toParams(secondTurn('claude-opus-5-5', 'answer'));

    expect(forced.tool_choice).toEqual({ type: 'auto' });
    // Byte for byte, so the thinking blocks of earlier turns stay valid.
    expect(forced.system).toBe(before.system);
    expect(forced.messages.slice(0, 2)).toEqual(before.messages.slice(0, 2));
    expect(forced.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '[]' },
        { type: 'text', text: 'Finish by calling the answer tool.' },
      ],
    });
  });

  it("offers Claude's web search, at most `maxUses` times, in the version the model supports", () => {
    const request = (model: string): AiRequest => ({ ...secondTurn(model), webSearch: { maxUses: 5 } });

    expect(toParams(request('claude-opus-5-5')).tools).toEqual([
      { name: 'answer', description: 'Answer.', input_schema: { type: 'object' } },
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
    ]);
    expect(toParams(request('claude-haiku-4-5')).tools?.at(-1)).toEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
    expect(toParams(secondTurn('claude-opus-5-5')).tools).toHaveLength(1);
  });

  it("keeps a search's blocks with the URLs it found, and passes them back exactly as they came", () => {
    const search = { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'ring trends' } } as Anthropic.ContentBlock;
    const results = {
      type: 'web_search_tool_result',
      tool_use_id: 'srv_1',
      content: [
        { type: 'web_search_result', url: 'https://trends.example.test/a', title: 'A', encrypted_content: 'e1', page_age: null },
        { type: 'web_search_result', url: 'https://trends.example.test/b', title: 'B', encrypted_content: 'e2', page_age: null },
      ],
    } as Anthropic.ContentBlock;
    const failed = { type: 'web_search_tool_result', tool_use_id: 'srv_2', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } } as Anthropic.ContentBlock;

    const content = fromBlocks([thinking, search, results, failed, toolUse]);

    expect(content).toEqual([
      { type: 'reasoning', raw: thinking },
      { type: 'server_tool', raw: search },
      { type: 'web_results', urls: ['https://trends.example.test/a', 'https://trends.example.test/b'], raw: results },
      { type: 'web_results', urls: [], raw: failed },
      { type: 'tool_use', id: 'call_1', name: 'find_orders', input: { late: true } },
    ]);
    const params = toParams({ ...secondTurn('claude-opus-5-5'), messages: [{ role: 'user', content: 'Trends?' }, { role: 'assistant', content }] });
    expect(params.messages[1]).toEqual({
      role: 'assistant',
      content: [thinking, search, results, failed, { type: 'tool_use', id: 'call_1', name: 'find_orders', input: { late: true } }],
    });
  });

  it('counts the web searches a call made, and reads a paused turn as paused', () => {
    const usage = { input_tokens: 120, output_tokens: 40, server_tool_use: { web_search_requests: 2 } } as Anthropic.Usage;

    expect(usageOf(usage)).toEqual({ inputTokens: 120, outputTokens: 40, webSearches: 2 });
    expect(usageOf({ input_tokens: 1, output_tokens: 2 } as Anthropic.Usage)).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(stopReasonOf('pause_turn')).toBe('pause_turn');
  });

  it('asks for the final tool after a question asked in plain text', () => {
    const request: AiRequest = { ...secondTurn('claude-sonnet-5-5', 'answer'), messages: [{ role: 'user', content: 'Anything late?' }] };

    expect(toParams(request).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Anything late?' },
          { type: 'text', text: 'Finish by calling the answer tool.' },
        ],
      },
    ]);
  });
});
