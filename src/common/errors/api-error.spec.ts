import { BadRequestException, NotFoundException } from '@nestjs/common';
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
