import { FakeAiProvider, fakeText, fakeToolUse } from './fake-ai-provider';
import type { AiRequest } from './ai-provider';

const request = (question: string): AiRequest => ({
  model: 'claude-sonnet-5-5',
  system: 'You answer from the workspace data.',
  messages: [{ role: 'user', content: question }],
  tools: [],
  maxTokens: 1000,
});

describe('FakeAiProvider', () => {
  it('returns the scripted responses in order and records every request', async () => {
    const provider = new FakeAiProvider();
    provider.script(fakeToolUse('find_orders', { status: 'late' }, 'call_1'), fakeText('Two orders are late.'));

    const first = await provider.complete(request('Which orders are late?'));
    const second = await provider.complete(request('And for Brightline?'));

    expect(first).toEqual({
      content: [{ type: 'tool_use', id: 'call_1', name: 'find_orders', input: { status: 'late' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    expect(second).toEqual({
      content: [{ type: 'text', text: 'Two orders are late.' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    expect(provider.calls).toEqual([request('Which orders are late?'), request('And for Brightline?')]);
  });

  it('gives a tool use an id when none is passed', () => {
    const [content] = fakeToolUse('answer', { text: 'Done.' }).content;

    expect(content).toMatchObject({ type: 'tool_use', name: 'answer' });
    expect(content.type === 'tool_use' && content.id).toMatch(/\S/);
  });

  it('throws once nothing is left to return', async () => {
    const provider = new FakeAiProvider();
    provider.script(fakeText('Only one.'));
    await provider.complete(request('First'));

    await expect(provider.complete(request('Second'))).rejects.toThrow('FakeAiProvider: nothing scripted');
    expect(provider.calls).toHaveLength(2);
  });
});
