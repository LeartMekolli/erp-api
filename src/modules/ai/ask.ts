import { z } from 'zod';
import type { AiContent, AiMessage, AiProvider, AiResponse } from './ai-provider';
import type { RunOutcome } from './runs.service';
import { SUGGESTION_KINDS, targetsFit } from './suggestions';
import { recordRefSchema, toolSpec } from './tools/tool';
import type { AiTool, RecordRef, ToolContext } from './tools/tool';

/** Rounds of tool calls before `answer` is forced. */
export const MAX_TOOL_ROUNDS = 6;
const MAX_TOKENS = 2_000;

/** The model's final output: text, the records it cites, and at most one proposed action. */
export const answerSchema = z.strictObject({
  text: z.string().max(1_500),
  refs: z.array(recordRefSchema).max(20),
  action: z.strictObject({ kind: z.enum(SUGGESTION_KINDS), targets: z.array(recordRefSchema).min(1).max(2) }).nullable(),
});
export type Answer = z.infer<typeof answerSchema>;

export const ANSWER_TOOL = {
  name: 'answer',
  description:
    'Give your final answer. Cite in `refs` every record your answer relies on, only from tool results of this ' +
    'conversation. `action` proposes at most one action for a person to confirm, or null.',
  input: answerSchema,
};

const key = (ref: RecordRef) => `${ref.type}:${ref.id}`;

/**
 * Asks the model with `tools` until it calls `answer` (AI 1 spec, goals 12 and 13). Every input is
 * validated; an invalid one, or an unknown tool, is given back as an error. After `MAX_TOOL_ROUNDS` the
 * answer is forced. Before returning, a cited record the tools never returned is dropped, and so is an
 * action unless every target was returned and fits its kind (Review Focus 3).
 */
export async function runTools(
  provider: AiProvider,
  request: { model: string; system: string; question: string; tools: AiTool<unknown>[]; ctx: ToolContext },
): Promise<RunOutcome> {
  const specs = [...request.tools.map(toolSpec), toolSpec(ANSWER_TOOL)];
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
      ...(force ? { forceTool: ANSWER_TOOL.name } : {}),
      maxTokens: MAX_TOKENS,
    });
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    if (response.stopReason === 'refusal') return failed('The model declined to answer');

    const uses = response.content.filter((block): block is Extract<AiContent, { type: 'tool_use' }> => block.type === 'tool_use');
    const answer = uses.find((use) => use.name === ANSWER_TOOL.name);
    if (answer) {
      const parsed = answerSchema.safeParse(answer.input);
      if (parsed.success) return { status: 'done', usage, output: checked(parsed.data, seen), refs: [...seen.values()], error: null };
      if (force) return failed('The model gave no answer');
    } else if (force) {
      return failed('The model gave no answer');
    }
    if (uses.length === 0) {
      // Text alone: the next turn must answer.
      force = true;
      messages.push({ role: 'assistant', content: response.content.length > 0 ? response.content : [{ type: 'text', text: '…' }] });
      messages.push({ role: 'user', content: 'Give your answer with the answer tool.' });
      continue;
    }

    messages.push({ role: 'assistant', content: response.content });
    const results: { type: 'tool_result'; toolUseId: string; content: string }[] = [];
    for (const use of uses) {
      results.push({ type: 'tool_result', toolUseId: use.id, content: await runOne(request.tools, use, request.ctx, seen) });
    }
    messages.push({ role: 'user', content: results });
  }
}

async function runOne(
  tools: AiTool<unknown>[],
  use: { name: string; input: unknown },
  ctx: ToolContext,
  seen: Map<string, RecordRef>,
): Promise<string> {
  if (use.name === ANSWER_TOOL.name) {
    return `Error: the answer did not match its schema. ${JSON.stringify(answerSchema.safeParse(use.input).error?.issues ?? [])}`;
  }
  const tool = tools.find((one) => one.name === use.name);
  if (!tool) return `Error: there is no tool named ${use.name}.`;
  const input = tool.input.safeParse(use.input);
  if (!input.success) return `Error: invalid input for ${use.name}: ${JSON.stringify(input.error.issues)}`;
  const result = await tool.run(ctx, input.data);
  for (const ref of result.refs) seen.set(key(ref), ref);
  return JSON.stringify(result.data);
}

/** Only what the tools returned may be cited or acted on. */
function checked(answer: Answer, seen: Map<string, RecordRef>): Answer {
  const known = (ref: RecordRef) => seen.has(key(ref));
  const refs = answer.refs.filter(known);
  const action = answer.action && answer.action.targets.every(known) && targetsFit(answer.action.kind, answer.action.targets) ? answer.action : null;
  return { text: answer.text, refs, action };
}
