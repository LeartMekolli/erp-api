import type { NextFunction, Request, Response } from 'express';
import { currentRequestId } from './request-context';
import { requestIdMiddleware } from './request-id.middleware';

function run(incoming?: string): { header: string | undefined; inside: string | undefined } {
  const request = { headers: incoming === undefined ? {} : { 'x-request-id': incoming } } as Request;
  let header: string | undefined;
  const response = {
    setHeader: (name: string, value: string) => {
      if (name === 'x-request-id') header = value;
    },
  } as unknown as Response;
  let inside: string | undefined;
  const next: NextFunction = () => {
    inside = currentRequestId();
  };

  requestIdMiddleware(request, response, next);

  return { header, inside };
}

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('request id middleware', () => {
  it('keeps a well-formed incoming x-request-id', () => {
    expect(run('abc-123')).toEqual({ header: 'abc-123', inside: 'abc-123' });
  });

  it.each(['x'.repeat(65), 'a b', 'a\nb', ''])('replaces the malformed id %j', (incoming) => {
    const { header, inside } = run(incoming);

    expect(header).toMatch(V7);
    expect(inside).toBe(header);
  });

  it('generates one when absent', () => {
    const { header, inside } = run();

    expect(header).toMatch(V7);
    expect(inside).toBe(header);
  });

  it('has no request id outside a request', () => {
    expect(currentRequestId()).toBeUndefined();
  });
});
