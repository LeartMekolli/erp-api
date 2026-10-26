import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { toApiError } from './api-error';

describe('toApiError', () => {
  it('maps a Nest HTTP exception, keeping its message as the detail', () => {
    expect(toApiError(new NotFoundException('no such tenant'))).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'no such tenant',
    });
  });

  it('keeps the detail of a deliberate bad request', () => {
    expect(toApiError(new BadRequestException('cursor is invalid')).detail).toBe('cursor is invalid');
  });

  it('keeps the entries a deliberate refusal names', () => {
    const errors = [{ path: 'work_order_ids.0', message: '1/3 is at casting, not polishing' }];

    expect(toApiError(new ConflictException({ message: 'Some pieces cannot move', errors }))).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'Some pieces cannot move',
      errors,
    });
  });

  it('passes on the extension members of a refusal with a code, and nothing else', () => {
    const lines = [{ position: 0, previous_quote_id: 'q1', quote: null, reasons: [] }];

    expect(toApiError(new ConflictException({ code: 'price_changed', message: 'Prices changed', lines, status: 200 }))).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'Prices changed',
      code: 'price_changed',
      lines,
    });
    expect(toApiError(new ConflictException({ message: 'Some pieces cannot move', lines }))).not.toHaveProperty('lines');
  });

  it('maps a validation failure to one entry per bad field', () => {
    const result = z.object({ name: z.string(), age: z.number() }).safeParse({ name: 123 });
    const apiError = toApiError(result.success ? new Error('unreachable') : result.error);

    expect(apiError.status).toBe(400);
    expect(apiError.type).toBe('urn:problem:validation');
    expect(apiError.errors?.map((e) => e.path)).toEqual(['name', 'age']);
    expect(apiError.errors?.every((e) => e.message.length > 0)).toBe(true);
  });

  it('reports a nested field with its full path', () => {
    const result = z
      .object({ sender: z.object({ email: z.email() }) })
      .safeParse({ sender: { email: 'nope' } });
    const apiError = toApiError(result.success ? new Error('unreachable') : result.error);

    expect(apiError.errors?.[0]?.path).toBe('sender.email');
  });

  it('hides the detail of an unexpected error', () => {
    const apiError = toApiError(new Error('relation "user" does not exist'));

    expect(apiError.status).toBe(500);
    expect(apiError.detail).toBe('An unexpected error occurred.');
    expect(JSON.stringify(apiError)).not.toContain('relation');
  });

  it('hides the detail of a thrown non-error', () => {
    const apiError = toApiError('postgresql://user:secret@host/db');

    expect(apiError.status).toBe(500);
    expect(JSON.stringify(apiError)).not.toContain('secret');
  });
});
