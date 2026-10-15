import { Body, Controller, Get, INestApplication, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { ErrorsModule } from '../src/common/errors/errors.module';
import { ZodValidationPipe } from '../src/common/validation/zod-validation.pipe';

const createSchema = z.object({ name: z.string().min(1) });

@Controller('fixture')
class FixtureController {
  @Post()
  create(@Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>) {
    return body;
  }

  @Get('boom')
  boom(): never {
    throw new Error('relation "user" does not exist');
  }
}

@Module({ imports: [ErrorsModule], controllers: [FixtureController] })
class FixtureModule {}

describe('error responses', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [FixtureModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns problem+json with field errors for an invalid body', async () => {
    const response = await request(app.getHttpServer()).post('/fixture').send({}).expect(400);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.type).toBe('urn:problem:validation');
    expect(response.body.errors.map((e: { path: string }) => e.path)).toEqual(['name']);
  });

  it('strips unknown keys instead of accepting them', async () => {
    const response = await request(app.getHttpServer())
      .post('/fixture')
      .send({ name: 'ok', isAdmin: true })
      .expect(201);

    expect(response.body).toEqual({ name: 'ok' });
  });

  it('sanitises an unexpected error into a 500 that leaks nothing', async () => {
    const response = await request(app.getHttpServer()).get('/fixture/boom').expect(500);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.detail).toBe('An unexpected error occurred.');
    expect(JSON.stringify(response.body)).not.toContain('relation');
  });

  it('returns problem+json for an unknown route', async () => {
    const response = await request(app.getHttpServer()).get('/nope').expect(404);

    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.status).toBe(404);
  });
});
