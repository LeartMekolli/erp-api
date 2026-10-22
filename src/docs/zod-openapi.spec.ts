import { z } from 'zod';
import { zodToOpenApi } from './zod-openapi';

describe('zodToOpenApi', () => {
  it('documents the input side of a converting schema without throwing', () => {
    const schema = z.object({
      content_type: z.string().trim().toLowerCase(),
      limit: z.coerce.number().int().max(200).default(50),
      window: z.object({ start: z.number(), end: z.number() }).refine((w) => w.end > w.start),
    });

    const result = zodToOpenApi(schema);

    expect(result).toMatchObject({ type: 'object', properties: { content_type: { type: 'string' } } });
    expect(result).not.toHaveProperty('$schema');
  });

  it('documents nullable fields the OpenAPI 3.0 way', () => {
    expect(zodToOpenApi(z.object({ checksum: z.string().nullable() }), 'output')).toMatchObject({
      properties: { checksum: { type: 'string', nullable: true } },
    });
  });
});
