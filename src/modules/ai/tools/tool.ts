import { z } from 'zod';
import type { TenantAuth } from '../../identity/auth-context';
import type { TenantPermission } from '../../identity/permissions';
import type { AiToolSpec } from '../ai-provider';

export const RECORD_TYPES = ['order', 'customer', 'partner', 'invoice', 'job', 'article', 'step'] as const;

/** A record a run's tools returned, by id only: what an answer may cite and the run log keeps. */
export interface RecordRef {
  type: (typeof RECORD_TYPES)[number];
  id: string;
}

export const recordRefSchema = z.strictObject({ type: z.enum(RECORD_TYPES), id: z.uuid() });

/** Who a tool runs as: the asking user's workspace and permissions, as loaded when the run executes. */
export interface ToolContext {
  tenantId: string;
  permissions: ReadonlySet<TenantPermission>;
  userId: string | null;
}

/** What a tool gives the model, and the refs of every record in it. */
export interface ToolResult {
  data: unknown;
  refs: RecordRef[];
}

/**
 * A read-only tool the model may call (AI 1 spec, goal 12). It wraps an existing read and runs with the
 * asking user's permissions; it is offered only to someone holding every one of `permissions`.
 */
export interface AiTool<I> {
  name: string;
  description: string;
  permissions: TenantPermission[];
  input: z.ZodType<I>;
  run(ctx: ToolContext, input: I): Promise<ToolResult>;
}

/** DI token for every tool the AI may be offered. */
export const AI_TOOLS = Symbol('AI_TOOLS');

/** The most rows a tool returns. */
export const MAX_TOOL_ROWS = 25;

export function toolSpec(tool: { name: string; description: string; input: z.ZodType }): AiToolSpec {
  return { name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.input) as Record<string, unknown> };
}

/** The tools `ctx` may use. */
export function offeredTo<T extends { permissions: TenantPermission[] }>(tools: T[], permissions: ReadonlySet<TenantPermission>): T[] {
  return tools.filter((tool) => tool.permissions.every((permission) => permissions.has(permission)));
}

/** The context as a `TenantAuth`, for services that take one. Never a token: no request carries it. */
export function authOf(ctx: ToolContext): TenantAuth {
  return { scope: 'tenant', tenantId: ctx.tenantId, userId: ctx.userId ?? '', jti: '', expiresAt: new Date(0), permissions: ctx.permissions };
}
