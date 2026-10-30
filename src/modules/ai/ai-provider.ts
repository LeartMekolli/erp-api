/**
 * The one way the API talks to a language model (AI spec). Our own shapes, so a provider other than
 * Claude could replace it; `ClaudeAiProvider` maps them one to one. Only ever called from a job, never
 * inside a request or a database transaction.
 */
export type AiContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  // A provider's own block (Claude's thinking), passed back unchanged on the next call of the run.
  | { type: 'reasoning'; raw: unknown }
  // A web search's results, with the URLs found; passed back unchanged like `reasoning`.
  | { type: 'web_results'; urls: string[]; raw: unknown }
  // Any other block of a tool the provider runs itself (the search call), passed back unchanged.
  | { type: 'server_tool'; raw: unknown };

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
  /** Offers the provider's own web search, at most `maxUses` times in the call. */
  webSearch?: { maxUses: number };
}

export interface AiResponse {
  content: AiContent[];
  /**
   * `refusal`: the model declined; the run fails rather than answering. `pause_turn`: the provider paused
   * its own tools' loop; sending the content back resumes it.
   */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn';
  usage: { inputTokens: number; outputTokens: number; webSearches?: number };
}

export interface AiProvider {
  complete(request: AiRequest): Promise<AiResponse>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');
