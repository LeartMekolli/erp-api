/**
 * The one way the API talks to a language model (AI spec). Our own shapes, so a provider other than
 * Claude could replace it; `ClaudeAiProvider` maps them one to one. Only ever called from a job, never
 * inside a request or a database transaction.
 */
export type AiContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export type AiMessage =
  | { role: 'user'; content: string | { type: 'tool_result'; toolUseId: string; content: string }[] }
  | { role: 'assistant'; content: AiContent[] };

export interface AiToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface AiRequest {
  model: string;
  system: string;
  messages: AiMessage[];
  tools: AiToolSpec[];
  /** Forces this tool on the turn (the final `answer`). */
  forceTool?: string;
  maxTokens: number;
}

export interface AiResponse {
  content: AiContent[];
  /** `refusal`: the model declined; the run fails rather than answering. */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  usage: { inputTokens: number; outputTokens: number };
}

export interface AiProvider {
  complete(request: AiRequest): Promise<AiResponse>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');
