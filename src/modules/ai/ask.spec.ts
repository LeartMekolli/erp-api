import { z } from 'zod';
import type { TenantPermission } from '../identity/permissions';
import { RUN_INPUT_BUDGET } from './ai-models';
import { ANSWER_TOOL, MAX_TOOL_ROUNDS, runTools } from './ask';
import type { Answer, FinalTool } from './ask';
import { FakeAiProvider, fakeText, fakeToolUse, fakeWebSearch } from './fake-ai-provider';
import type { AiTool, RecordRef, ToolContext } from './tools/tool';

const ORDER = '01900000-0000-7000-8000-000000000001';
const OTHER_ORDER = '01900000-0000-7000-8000-000000000002';
const JOB = '01900000-0000-7000-8000-000000000003';
const PARTNER = '01900000-0000-7000-8000-000000000004';

const ctx: ToolContext = {
  tenantId: '01900000-0000-7000-8000-0000000000aa',
  permissions: new Set<TenantPermission>(['order.read']),
  userId: null,
};

/** Returns the order and the waiting job; records what it was asked. */
function stubTools() {
  const asked: unknown[] = [];
  const findOrders: AiTool<{ late?: boolean }> = {
    name: 'find_orders',
    description: 'Find orders.',
    permissions: ['order.read'],
    input: z.strictObject({ late: z.boolean().optional() }),
    run: (_ctx, input) => {
      asked.push(input);
      const refs: RecordRef[] = [
        { type: 'order', id: ORDER },
        { type: 'job', id: JOB },
      ];
      return Promise.resolve({ data: [{ id: ORDER, number: 1042, late: true, job_id: JOB }], refs });
    },
  };
  const getPartner: AiTool<{ id: string }> = {
    name: 'get_partner',
    description: 'One partner.',
    permissions: ['partner.read'],
    input: z.strictObject({ id: z.uuid() }),
    run: () => Promise.resolve({ data: null, refs: [] }),
  };
  return { asked, tools: [findOrders, getPartner] as AiTool<unknown>[] };
}

const answer = (input: object) => fakeToolUse('answer', { text: 'Order 1042 is late.', refs: [], action: null, ...input });

async function ask(provider: FakeAiProvider, tools: AiTool<unknown>[]) {
  return runTools(provider, { model: 'claude-haiku-4-5', system: 'Answer from tool results.', question: 'Which orders are late?', tools, ctx });
}

describe('runTools', () => {
  it('runs the tools the model calls, then returns its answer with the usage of every turn summed', async () => {
    const provider = new FakeAiProvider();
    const { asked, tools } = stubTools();
    provider.script(fakeToolUse('find_orders', { late: true }, 'call_1'), answer({ refs: [{ type: 'order', id: ORDER }] }));

    const outcome = await ask(provider, tools);

    expect(asked).toEqual([{ late: true }]);
    expect(outcome).toMatchObject({
      status: 'done',
      usage: { inputTokens: 200, outputTokens: 100 },
      output: { text: 'Order 1042 is late.', refs: [{ type: 'order', id: ORDER }], action: null },
      error: null,
    });
    expect(outcome.refs).toEqual([
      { type: 'order', id: ORDER },
      { type: 'job', id: JOB },
    ]);
    // The second turn carries the tool's result back, and every turn offers the tools and `answer`.
    const second = provider.calls[1];
    expect(second.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'call_1', content: expect.stringContaining('1042') }],
    });
    expect(second.tools.map((tool) => tool.name)).toEqual(['find_orders', 'get_partner', 'answer']);
  });

  it('drops a cited record the tools never returned (Review Focus 3)', async () => {
    const provider = new FakeAiProvider();
    provider.script(
      fakeToolUse('find_orders', {}),
      answer({ refs: [{ type: 'order', id: ORDER }, { type: 'order', id: OTHER_ORDER }] }),
    );

    const outcome = await ask(provider, stubTools().tools);

    expect(outcome.output).toMatchObject({ refs: [{ type: 'order', id: ORDER }] });
  });

  it('drops an action whose targets the tools did not all return (Review Focus 3)', async () => {
    const provider = new FakeAiProvider();
    provider.script(
      fakeToolUse('find_orders', {}),
      answer({ action: { kind: 'offer_job', targets: [{ type: 'job', id: JOB }, { type: 'partner', id: PARTNER }] } }),
    );

    expect((await ask(provider, stubTools().tools)).output).toMatchObject({ action: null });
  });

  it('keeps an action whose targets were all returned and are of its kind', async () => {
    const provider = new FakeAiProvider();
    provider.script(fakeToolUse('find_orders', {}), answer({ action: { kind: 'release_order', targets: [{ type: 'order', id: ORDER }] } }));

    expect((await ask(provider, stubTools().tools)).output).toMatchObject({
      action: { kind: 'release_order', targets: [{ type: 'order', id: ORDER }] },
    });
  });

  it('drops an action naming a target of the wrong type', async () => {
    const provider = new FakeAiProvider();
    provider.script(fakeToolUse('find_orders', {}), answer({ action: { kind: 'chase_invoice', targets: [{ type: 'order', id: ORDER }] } }));

    expect((await ask(provider, stubTools().tools)).output).toMatchObject({ action: null });
  });

  it('gives an invalid tool input and an unknown tool back to the model as errors', async () => {
    const provider = new FakeAiProvider();
    const { asked, tools } = stubTools();
    provider.script(fakeToolUse('find_orders', { late: 'yes' }, 'call_1'), fakeToolUse('drop_tables', {}, 'call_2'), answer({}));

    const outcome = await ask(provider, tools);

    expect(asked).toEqual([]);
    expect(provider.calls[1].messages.at(-1)).toMatchObject({ content: [{ toolUseId: 'call_1', content: expect.stringContaining('late') }] });
    expect(provider.calls[2].messages.at(-1)).toMatchObject({ content: [{ toolUseId: 'call_2', content: expect.stringContaining('drop_tables') }] });
    expect(outcome.status).toBe('done');
  });

  it(`forces the answer after ${MAX_TOOL_ROUNDS} rounds of tools, and fails a run that still gives none`, async () => {
    const provider = new FakeAiProvider();
    provider.script(...Array.from({ length: MAX_TOOL_ROUNDS + 1 }, () => fakeToolUse('find_orders', {})));

    const outcome = await ask(provider, stubTools().tools);

    expect(provider.calls).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(provider.calls.slice(0, MAX_TOOL_ROUNDS).every((call) => call.forceTool === undefined)).toBe(true);
    expect(provider.calls[MAX_TOOL_ROUNDS].forceTool).toBe('answer');
    expect(outcome).toMatchObject({ status: 'failed', output: null, error: 'The model gave no answer' });
    expect(outcome.usage).toEqual({ inputTokens: 100 * (MAX_TOOL_ROUNDS + 1), outputTokens: 50 * (MAX_TOOL_ROUNDS + 1) });
  });

  it('forces the answer on the next turn when the model replies with text alone', async () => {
    const provider = new FakeAiProvider();
    provider.script(fakeText('Let me think.'), answer({}));

    const outcome = await ask(provider, stubTools().tools);

    expect(provider.calls[1].forceTool).toBe('answer');
    expect(outcome.status).toBe('done');
  });

  it('fails a run whose provider refuses', async () => {
    const provider = new FakeAiProvider();
    provider.script({ content: [], stopReason: 'refusal', usage: { inputTokens: 10, outputTokens: 0 } });

    expect(await ask(provider, stubTools().tools)).toMatchObject({ status: 'failed', error: 'The model declined to answer' });
  });

  it('ends a run that already spent as failed, with its tokens, when the provider then fails (review fix)', async () => {
    const provider = new FakeAiProvider();
    // The second call finds nothing scripted and throws, as an outage after the first turn would.
    provider.script(fakeToolUse('find_orders', { late: true }));

    const outcome = await ask(provider, stubTools().tools);

    expect(outcome).toMatchObject({
      status: 'failed',
      usage: { inputTokens: 100, outputTokens: 50 },
      output: null,
      error: 'The model could not be reached',
    });
    expect(outcome.refs).toEqual([
      { type: 'order', id: ORDER },
      { type: 'job', id: JOB },
    ]);
  });

  it('lets a provider failure on the first call through, so the job may retry a run that spent nothing', async () => {
    await expect(ask(new FakeAiProvider(), stubTools().tools)).rejects.toThrow('nothing scripted');
  });

  it('gives a tool that throws back to the model as an error, and carries on', async () => {
    const provider = new FakeAiProvider();
    const broken: AiTool<Record<string, never>> = {
      name: 'broken',
      description: 'Always fails.',
      permissions: [],
      input: z.strictObject({}),
      run: () => Promise.reject(new Error('connection reset')),
    };
    provider.script(fakeToolUse('broken', {}, 'call_broken'), answer({}));

    const outcome = await ask(provider, [...stubTools().tools, broken as AiTool<unknown>]);

    expect(outcome.status).toBe('done');
    const result = JSON.stringify(provider.calls[1].messages.at(-1));
    expect(result).toContain('call_broken');
    expect(result).toContain('Error');
    // What failed inside is not given to the model.
    expect(result).not.toContain('connection reset');
  });

  it(`forces the answer once the run's input reaches ${RUN_INPUT_BUDGET} tokens`, async () => {
    const provider = new FakeAiProvider();
    provider.script(
      { ...fakeToolUse('find_orders', {}), usage: { inputTokens: RUN_INPUT_BUDGET, outputTokens: 50 } },
      answer({}),
    );

    const outcome = await ask(provider, stubTools().tools);

    expect(provider.calls[0].forceTool).toBeUndefined();
    expect(provider.calls[1].forceTool).toBe('answer');
    expect(outcome.status).toBe('done');
  });

  it('resumes a turn paused after a web search, gives the final tool the URLs found, and pays for each search', async () => {
    const provider = new FakeAiProvider();
    provider.script(fakeWebSearch(['https://trends.example.test/a']), fakeWebSearch(['https://trends.example.test/b']), answer({}));
    let seen: ReadonlySet<string> = new Set();
    const final: FinalTool<Answer> = {
      ...ANSWER_TOOL,
      check: (output, known, urls) => {
        seen = urls;
        return ANSWER_TOOL.check(output, known, urls);
      },
    };

    const outcome = await runTools(provider, {
      model: 'claude-haiku-4-5',
      system: 'Answer.',
      question: 'Trends?',
      tools: [],
      ctx,
      final,
      webSearch: { maxUses: 5 },
    });

    expect(outcome.status).toBe('done');
    expect([...seen].sort()).toEqual(['https://trends.example.test/a', 'https://trends.example.test/b']);
    expect(outcome.usage).toEqual({ inputTokens: 300, outputTokens: 150 });
    expect(outcome.extraCostUsd?.toFixed(2)).toBe('0.02');
    // Every call offers the searches left; a paused turn goes back as it came, with no message of ours after it.
    expect(provider.calls.map((call) => call.webSearch)).toEqual([{ maxUses: 5 }, { maxUses: 4 }, { maxUses: 3 }]);
    expect(provider.calls[1].messages).toHaveLength(2);
    expect(provider.calls[1].messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'server_tool' }, { type: 'web_results' }] });
  });

  it('stops offering the search once the run has made every search it may (review fix)', async () => {
    const provider = new FakeAiProvider();
    provider.script(fakeWebSearch(['https://trends.example.test/a']), fakeWebSearch(['https://trends.example.test/b']), answer({}));

    const outcome = await runTools(provider, { model: 'claude-haiku-4-5', system: 'Answer.', question: 'Trends?', tools: [], ctx, webSearch: { maxUses: 2 } });

    expect(outcome.status).toBe('done');
    expect(provider.calls.map((call) => call.webSearch)).toEqual([{ maxUses: 2 }, { maxUses: 1 }, undefined]);
    expect(outcome.extraCostUsd?.toFixed(2)).toBe('0.02');
  });

  it('pays for the searches of a run that fails after them', async () => {
    const provider = new FakeAiProvider();
    provider.script(fakeWebSearch(['https://trends.example.test/a']), { ...fakeText('No.'), stopReason: 'refusal' });

    const outcome = await runTools(provider, { model: 'claude-haiku-4-5', system: 'Answer.', question: 'Trends?', tools: [], ctx, webSearch: { maxUses: 5 } });

    expect(outcome.status).toBe('failed');
    expect(outcome.extraCostUsd?.toFixed(2)).toBe('0.01');
  });

  it('costs nothing beyond tokens without a search', async () => {
    const provider = new FakeAiProvider();
    provider.script(answer({}));

    expect((await ask(provider, stubTools().tools)).extraCostUsd).toBeUndefined();
  });
});
