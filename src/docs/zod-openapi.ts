import type { SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';

/**
 * A Zod schema as an OpenAPI 3.0 schema, through Zod's own converter, so the
 * docs describe exactly what the code validates. Requests are documented on
 * the input side (what a client sends, before trimming or coercion); rules
 * JSON Schema cannot express, such as refinements, are left out rather than
 * failing the whole document.
 */
export function zodToOpenApi(schema: z.core.$ZodType, io: 'input' | 'output' = 'input'): SchemaObject {
  const json = z.toJSONSchema(schema, { target: 'openapi-3.0', io, unrepresentable: 'any' }) as Record<string, unknown>;
  // The dialect marker belongs to standalone JSON Schema documents, not to an OpenAPI schema.
  delete json.$schema;
  return json as SchemaObject;
}
