import type Anthropic from '@anthropic-ai/sdk';
import type { AiMessage, AiRequest } from './ai-provider';
import { fromBlocks, toParams } from './claude-ai-provider';

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
