import type { NextFunction, Request, Response } from 'express';
import { newId } from '../ids/uuid';
import { RequestContext, bindRequestContext, requestContext } from './request-context';

/**
 * An incoming id is kept so a trace can cross services, but only in a shape
 * that is safe to echo and to write into a log line.
 */
const ACCEPTED_ID = /^[A-Za-z0-9-]{1,64}$/;

export function requestIdMiddleware(request: Request, response: Response, next: NextFunction): void {
  const incoming = request.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && ACCEPTED_ID.test(incoming) ? incoming : newId();
  const context: RequestContext = { requestId };

  bindRequestContext(request, context);
  response.setHeader('x-request-id', requestId);
  requestContext.run(context, next);
}
