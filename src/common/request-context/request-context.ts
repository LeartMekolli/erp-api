import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';

/**
 * Who and what a request is, for logs, error reports and the audit trail's
 * request id. Never read for authorization: tenant scope is passed explicitly
 * from the verified token (ADR 0001).
 */
export interface RequestContext {
  requestId: string;
  tenantId?: string;
  userId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * The same object, keyed by request, for code that runs after the async scope
 * has ended — such as the request logger writing its line on response finish.
 */
const contextByRequest = new WeakMap<IncomingMessage, RequestContext>();

export function bindRequestContext(request: IncomingMessage, context: RequestContext): void {
  contextByRequest.set(request, context);
}

export function requestContextOf(request: IncomingMessage): RequestContext | undefined {
  return contextByRequest.get(request);
}

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
