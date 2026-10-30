import { z } from 'zod';
import type { AiContent, AiMessage, AiProvider, AiResponse } from './ai-provider';
import type { RunOutcome } from './runs.service';
import { SUGGESTION_KINDS, targetsFit } from './suggestions';
import { recordRefSchema, toolSpec } from './tools/tool';
import type { AiTool, RecordRef, ToolContext } from './tools/tool';

/** Rounds of tool calls before the final tool is forced. */
export const MAX_TOOL_ROUNDS = 6;
const MAX_TOKENS = 2_000;

/**
 * The tool a run ends with: its input is the run's output. `check` keeps only what the run's tools
 * returned (`known`), so the model can't cite or act on anything else.
 */
export interface FinalTool<T> {
  name: string;
  description: string;
  input: z.ZodType<T>;
  check(output: T, known: (ref: RecordRef) => boolean): T;
}

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
 * drops whatever the tools never returned (Review Focus 3).
 */
export async function runTools<T = Answer>(
  provider: AiProvider,
  request: { model: string; system: string; question: string; tools: AiTool<unknown>[]; ctx: ToolContext; final?: FinalTool<T> },
): Promise<RunOutcome> {
  const final = (request.final ?? ANSWER_TOOL) as FinalTool<T>;
  const specs = [...request.tools.map(toolSpec), toolSpec(final)];
  const messages: AiMessage[] = [{ role: 'user', content: request.question }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const seen = new Map<string, RecordRef>();
  const failed = (error: string): RunOutcome => ({ status: 'failed', usage, output: null, refs: [...seen.values()], error });

  let force = false;
  for (let round = 0; ; round += 1) {
    force ||= round >= MAX_TOOL_ROUNDS;
    const response: AiResponse = await provider.complete({
      model: request.model,
      system: request.system,
      // A copy: the conversation grows after the call.
      messages: [...messages],
      tools: specs,
      ...(force ? { forceTool: final.name } : {}),
      maxTokens: MAX_TOKENS,
    });
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    if (response.stopReason === 'refusal') return failed('The model declined to answer');

    const uses = response.content.filter((block): block is Extract<AiContent, { type: 'tool_use' }> => block.type === 'tool_use');
    const ending = uses.find((use) => use.name === final.name);
    if (ending) {
      const parsed = final.input.safeParse(ending.input);
      if (parsed.success) {
        const output = final.check(parsed.data, (ref) => seen.has(key(ref))) as object;
        return { status: 'done', usage, output, refs: [...seen.values()], error: null };
      }
      if (force) return failed('The model gave no answer');
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
  const input = tool.input.safeParse(use.input);
  if (!input.success) return `Error: invalid input for ${use.name}: ${JSON.stringify(input.error.issues)}`;
  const result = await tool.run(ctx, input.data);
  for (const ref of result.refs) seen.set(key(ref), ref);
  return JSON.stringify(result.data);
}
