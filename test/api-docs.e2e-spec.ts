import { Body, Controller, INestApplication, Post, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { OpenAPIObject, OperationObject, RequestBodyObject, SchemaObject } from '@nestjs/swagger';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConfigService, createConfigService } from '../src/config/config.service';
import { ApiDoc, IDEMPOTENCY_NOTE } from '../src/docs/api-doc';
import { buildOpenApiDocument } from '../src/docs/openapi-document';
import { Public } from '../src/modules/identity/route-markers';

describe('API docs', () => {
  const apps: INestApplication[] = [];

  async function boot(apiDocs: 'true' | 'false'): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(createConfigService({ ...process.env, API_DOCS: apiDocs }))
      .compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    apps.push(app);
    return app;
  }

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it('serves the page and the document when API_DOCS is true', async () => {
    const app = await boot('true');

    await request(app.getHttpServer()).get('/docs').expect(200);
    const doc = (await request(app.getHttpServer()).get('/docs/openapi.json').expect(200)).body as OpenAPIObject;

    expect(doc.components?.securitySchemes?.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.paths['/health/live'].get).toMatchObject({ summary: expect.any(String), security: [] });
    expect(doc.paths['/me'].get).toMatchObject({ security: [{ bearer: [] }] });
    expect(doc.paths['/me'].get?.description).toMatch(/any signed-in user/i);
  });

  it('answers 404 for both when API_DOCS is false', async () => {
    const app = await boot('false');

    await request(app.getHttpServer()).get('/docs').expect(404);
    await request(app.getHttpServer()).get('/docs/openapi.json').expect(404);
  });

  describe('coverage', () => {
    let app: INestApplication;
    let doc: OpenAPIObject;

    beforeAll(async () => {
      app = await boot('true');
      doc = (await request(app.getHttpServer()).get('/docs/openapi.json').expect(200)).body as OpenAPIObject;
    });

    /** Every handler of every controller, walked independently of the document builder. */
    function routes(): { label: string; path: string; method: string; readsBody: boolean }[] {
      const scanner = new MetadataScanner();
      const found: { label: string; path: string; method: string; readsBody: boolean }[] = [];
      for (const module of app.get(ModulesContainer).values()) {
        for (const wrapper of module.controllers.values()) {
          const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
          if (!controller) continue;
          const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
          const prototype = controller.prototype as Record<string, unknown>;
          for (const name of scanner.getAllMethodNames(prototype)) {
            const handler = prototype[name] as object;
            const own = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
            if (own === undefined) continue;
            const path = `/${[base, own].join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '').replace(/:(\w+)/g, '{$1}');
            const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod].toLowerCase();
            const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {}) as Record<string, unknown>;
            const readsBody = Object.keys(args).some((key) => key.split(':')[0] === String(RouteParamtypes.BODY));
            found.push({ label: `${method.toUpperCase()} ${path || '/'}`, path: path || '/', method, readsBody });
          }
        }
      }
      return found;
    }

    it('documents every route: summary, access, request body where one is read, a success response', () => {
      const all = routes();
      // Without this, a walk that found nothing would pass.
      expect(all.map((route) => route.label)).toEqual(expect.arrayContaining(['GET /health/live', 'POST /files']));

      const missing: string[] = [];
      for (const route of all) {
        const operation = (doc.paths[route.path] as Record<string, OperationObject> | undefined)?.[route.method];
        if (!operation) {
          missing.push(`${route.label}: not in the document`);
          continue;
        }
        if (!operation.summary) missing.push(`${route.label}: no summary`);
        if (!Array.isArray(operation.security)) missing.push(`${route.label}: no security`);
        if (!/Access: /.test(operation.description ?? '')) missing.push(`${route.label}: no access line`);
        if (!Object.keys(operation.responses).some((status) => /^2\d\d$/.test(status))) {
          missing.push(`${route.label}: no success response`);
        }
        if (route.readsBody && !operation.requestBody) missing.push(`${route.label}: no request body`);
      }
      expect(missing).toEqual([]);
    });

    it('shows the configured upload limit', () => {
      const body = doc.paths['/files'].post?.requestBody as RequestBodyObject;
      const schema = body.content['application/json'].schema as SchemaObject;
      expect(schema.properties?.size).toMatchObject({ maximum: app.get(ConfigService).get('FILE_MAX_BYTES') });
    });

    it('names the permission of a permission route', () => {
      expect(doc.paths['/files'].post?.description).toContain('Access: permission `file.write`.');
      expect(doc.paths['/files'].post?.security).toEqual([{ bearer: [] }]);
    });

    it('names the customer role of a portal route', () => {
      const invite = doc.paths['/portal/customers/{customerId}/invitations'].post;
      expect(invite?.description).toContain('Access: a person acting for the customer, at least `admin`.');
      expect(invite?.security).toEqual([{ bearer: [] }]);
    });

    it('documents query parameters from the route schema and drops internal headers', () => {
      const parameters = (doc.paths['/users'].get?.parameters ?? []) as { name: string; in: string; required: boolean }[];
      expect(parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'limit', in: 'query', required: false }),
          expect.objectContaining({ name: 'status', in: 'query', required: false }),
        ]),
      );
      const failed = (doc.paths['/platform/jobs/failed'].get?.parameters ?? []) as { name: string; required: boolean }[];
      expect(failed).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'queue', required: true })]));
      const login = (doc.paths['/auth/login'].post?.parameters ?? []) as { in: string }[];
      expect(login.filter((parameter) => parameter.in === 'header')).toEqual([]);
    });
  });

  describe('derived from the route', () => {
    let doc: OpenAPIObject;

    beforeAll(async () => {
      const app = await boot('true');
      doc = (await request(app.getHttpServer()).get('/docs/openapi.json').expect(200)).body as OpenAPIObject;
    });

    const statuses = (operation: OperationObject | undefined) => Object.keys(operation?.responses ?? {});

    it('lists 401 and 403 on every protected route, and neither 401 nor 403 on public ones by default', () => {
      expect(statuses(doc.paths['/me'].get)).toEqual(expect.arrayContaining(['401', '403']));
      expect(statuses(doc.paths['/platform/jobs/queues'].get)).toEqual(expect.arrayContaining(['401', '403']));
      expect(statuses(doc.paths['/health/live'].get)).not.toContain('403');
      expect(statuses(doc.paths['/auth/password-reset/confirm'].post)).not.toContain('403');
    });

    it('describes Idempotency-Key and its 409 on tenant POSTs only', () => {
      for (const path of ['/auth/logout', '/files', '/notifications/{id}/read', '/notification-templates/preview']) {
        expect(doc.paths[path].post?.description).toContain(IDEMPOTENCY_NOTE);
        expect(statuses(doc.paths[path].post)).toContain('409');
      }
      for (const path of ['/auth/login', '/platform/diagnostics/error']) {
        expect(doc.paths[path].post?.description).not.toContain('Idempotency-Key');
        expect(statuses(doc.paths[path].post)).not.toContain('409');
      }
    });
  });

  it('shows no request body for a route that reads one but documents no schema', async () => {
    @Controller('probe')
    class ProbeController {
      @ApiDoc({ summary: 'Reads a body, documents none.' })
      @Public()
      @Post()
      read(@Body() body: unknown): unknown {
        return body;
      }
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: ConfigService, useValue: createConfigService({ ...process.env }) }],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    apps.push(app);

    expect(buildOpenApiDocument(app).paths['/probe'].post?.requestBody).toBeUndefined();
  });
});
