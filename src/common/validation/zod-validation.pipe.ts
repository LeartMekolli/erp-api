import { PipeTransform } from '@nestjs/common';
import { ZodTypeAny } from 'zod';

/**
 * Parses a request body, query or parameter against a schema.
 *
 * Zod objects drop unknown keys, so whatever reaches a handler contains only
 * declared fields — the mass-assignment defence. A failure throws `ZodError`,
 * which `ApiErrorFilter` turns into a 400 with one entry per bad field.
 */
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): unknown {
    return this.schema.parse(value);
  }
}
