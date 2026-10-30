import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { MAX_OUTPUT_TOKENS, MAX_TOOL_ROUNDS, RUN_INPUT_BUDGET } from './ai-models';
import type { AiContent, AiMessage, AiProvider, AiResponse } from './ai-provider';
import { WEB_SEARCH_USD } from './extra-costs';
import type { RunOutcome } from './runs.service';
import { SUGGESTION_KINDS, targetsFit } from './suggestions';
import { recordRefSchema, toolSpec } from './tools/tool';
import type { AiTool, RecordRef, ToolContext } from './tools/tool';

export { MAX_TOOL_ROUNDS };

const logger = new Logger('runTools');

/**
 * The tool a run ends with: its input is the run's output. `check` keeps only what the run's tools
 * returned (`known`) and the pages its web searches found (`urls`), so the model can't cite or act on
 * anything else.
 */
export interface FinalTool<T> {
  name: string;
  description: string;
  input: z.ZodType<T>;
  check(output: T, known: (ref: RecordRef) => boolean, urls: ReadonlySet<string>): T;
}

/** Turns the provider may pause in its own tools' loop before the run gives up. */
const MAX_PAUSES = 3;

/** The model's final output: text, the records it cites, and at most one proposed action. */
export const answerSchema = z.strictObject({
  text: z.string().max(1_500),
  refs: z.array(recordRefSchema).max(20),
  action: z.strictObject({ kind: z.enum(SUGGESTION_KINDS), targets: z.array(recordRefSchema).min(1).max(2) }).nullable(),
});
export type Answer = z.infer<typeof answerSchema>;

export const ANSWER_TOOL: FinalTool<Answer> = {
  name: 'answer',
  description:
    'Give your final answer. Cite in `refs` every record your answer relies on, only from tool results of this ' +
    'conversation. `action` proposes at most one action for a person to confirm, or null.',
  input: answerSchema,
  check: (answer, known) => ({
    text: answer.text,
    refs: answer.refs.filter(known),
    action: answer.action && answer.action.targets.every(known) && targetsFit(answer.action.kind, answer.action.targets) ? answer.action : null,
  }),
};

const key = (ref: RecordRef) => `${ref.type}:${ref.id}`;

/**
 * Asks the model with `tools` until it calls the final tool, `answer` unless told otherwise (AI 1 spec,
 * goals 12 and 13). Every input is validated; an invalid one, or an unknown tool, is given back as an
 * error. After `MAX_TOOL_ROUNDS` the final tool is forced. Before returning, the final tool's `check`
 * drops whatever the tools never returned (Review Focus 3). With `webSearch`, the provider's own search is
 * offered on every call; each search is paid on the outcome, done or failed.
 */
export async function runTools<T = Answer>(
  provider: AiProvider,
  request: {
    model: string;
    system: string;
    question: string;
    tools: AiTool<unknown>[];
    ctx: ToolContext;
    final?: FinalTool<T>;
    webSearch?: { maxUses: number };
  },
): Promise<RunOutcome> {
  const final = (request.final ?? ANSWER_TOOL) as FinalTool<T>;
  const specs = [...request.tools.map(toolSpec), toolSpec(final)];
  const messages: AiMessage[] = [{ role: 'user', content: request.question }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const seen = new Map<string, RecordRef>();
  const urls = new Set<string>();
  let searches = 0;
  let pauses = 0;
  const extra = (): Pick<RunOutcome, 'extraCostUsd'> =>
    searches > 0 ? { extraCostUsd: new Prisma.Decimal(WEB_SEARCH_USD).mul(searches) } : {};
  const failed = (error: string): RunOutcome => ({ status: 'failed', usage, output: null, refs: [...seen.values()], error, ...extra() });

  let force = false;
  for (let round = 0; ; round += 1) {
    // The input budget bounds what a run can cost (worstRunCost), so the reserve is a real cap.
    force ||= round >= MAX_TOOL_ROUNDS || usage.inputTokens >= RUN_INPUT_BUDGET;
    let response: AiResponse;
    try {
      response = await provider.complete({
        model: request.model,
        system: request.system,
        // A copy: the conversation grows after the call.
        messages: [...messages],
        tools: specs,
        ...(force ? { forceTool: final.name } : {}),
        maxTokens: MAX_OUTPUT_TOKENS,
        ...(request.webSearch ? { webSearch: request.webSearch } : {}),
      });
    } catch (error) {
      // Nothing spent yet: the job may retry. Otherwise a retry would pay for this run's turns again.
      if (round === 0) throw error;
      logger.warn({ err: error }, 'the model failed partway through a run');
      return failed('The model could not be reached');
    }
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    searches += response.usage.webSearches ?? 0;
    for (const block of response.content) {
      if (block.type === 'web_results') for (const url of block.urls) urls.add(url);
    }
    if (response.stopReason === 'refusal') return failed('The model declined to answer');

    const uses = response.content.filter((block): block is Extract<AiContent, { type: 'tool_use' }> => block.type === 'tool_use');
    const ending = uses.find((use) => use.name === final.name);
    if (ending) {
      const parsed = final.input.safeParse(ending.input);
      if (parsed.success) {
        const output = final.check(parsed.data, (ref) => seen.has(key(ref)), urls) as object;
        return { status: 'done', usage, output, refs: [...seen.values()], error: null, ...extra() };
      }
      if (force) return failed('The model gave no answer');
    } else if (response.stopReason === 'pause_turn') {
      // The provider paused its own tools; the turn goes back as it came, with nothing of ours after it.
      pauses += 1;
      if (pauses > MAX_PAUSES) return failed('The model gave no answer');
      messages.push({ role: 'assistant', content: response.content });
      continue;
    } else if (force) {
      return failed('The model gave no answer');
    }
    if (uses.length === 0) {
      // Text alone: the next turn must end.
      force = true;
      messages.push({ role: 'assistant', content: response.content.length > 0 ? response.content : [{ type: 'text', text: '…' }] });
      messages.push({ role: 'user', content: `Finish with the ${final.name} tool.` });
      continue;
    }

    messages.push({ role: 'assistant', content: response.content });
    const results: { type: 'tool_result'; toolUseId: string; content: string }[] = [];
    for (const use of uses) {
      results.push({ type: 'tool_result', toolUseId: use.id, content: await runOne(request.tools, final, use, request.ctx, seen) });
    }
    messages.push({ role: 'user', content: results });
  }
}

async function runOne<T>(
  tools: AiTool<unknown>[],
  final: FinalTool<T>,
  use: { name: string; input: unknown },
  ctx: ToolContext,
  seen: Map<string, RecordRef>,
): Promise<string> {
  if (use.name === final.name) {
    return `Error: the ${final.name} input did not match its schema. ${JSON.stringify(final.input.safeParse(use.input).error?.issues ?? [])}`;
  }
  const tool = tools.find((one) => one.name === use.name);
  if (!tool) return `Error: there is no tool named ${use.name}.`;
  try {
    return await runTool(tool, use, ctx, seen);
  } catch (error) {
    // What failed inside stays in the log, never in the conversation.
    logger.warn({ err: error, tool: use.name }, 'an AI tool failed');
    return `Error: ${use.name} failed. Try another way, or answer with what you have.`;
  }
}

async function runTool(tool: AiTool<unknown>, use: { name: string; input: unknown }, ctx: ToolContext, seen: Map<string, RecordRef>): Promise<string> {
  const input = tool.input.safeParse(use.input);
  if (!input.success) return `Error: invalid input for ${use.name}: ${JSON.stringify(input.error.issues)}`;
  const result = await tool.run(ctx, input.data);
  for (const ref of result.refs) seen.set(key(ref), ref);
  return JSON.stringify(result.data);
}
