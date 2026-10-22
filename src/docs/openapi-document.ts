import { INestApplication, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject, OperationObject, ResponsesObject, SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';
import { ConfigService } from '../config/config.service';
import { ROUTE_MARKER } from '../modules/identity/route-markers';
import type { RouteMarker } from '../modules/identity/route-markers';
import { API_DOC, IDEMPOTENCY_NOTE } from './api-doc';
import type { ApiDocOptions, DocContext } from './api-doc';
import { zodToOpenApi } from './zod-openapi';

const PROBLEM_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['type', 'title', 'status'],
  properties: {
    type: { type: 'string', example: 'urn:problem:validation' },
    title: { type: 'string', example: 'Validation failed' },
    status: { type: 'integer', example: 400 },
    detail: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
};

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Invalid request',
  401: 'Missing or invalid token',
  403: 'Not allowed',
  404: 'Not found',
  409: 'Conflict with the current state',
  429: 'Too many attempts',
};

/** A route as the docs see it: where it lives and what its decorators say. */
export interface DocumentedRoute {
  /** OpenAPI form: `/files/{id}`. */
  path: string;
  /** Lowercase HTTP method: `get`, `post`, ... */
  method: string;
  status: number;
  marker: RouteMarker | undefined;
  doc: ApiDocOptions | undefined;
  handler: object;
}

function joinPath(...parts: string[]): string {
  const joined = parts
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment !== '')
    .map((segment) => (segment.startsWith(':') ? `{${segment.slice(1)}}` : segment))
    .join('/');
  return `/${joined}`;
}

/** Every route the application's controllers declare, read from Nest's own metadata. */
export function collectRoutes(app: INestApplication): DocumentedRoute[] {
  const scanner = new MetadataScanner();
  const routes: DocumentedRoute[] = [];

  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!controller) continue;
      const base = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
      const prototype = controller.prototype as Record<string, unknown>;

      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name] as object;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (path === undefined) continue;

        const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
        const method = RequestMethod[requestMethod].toLowerCase();
        const status =
          (Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined) ??
          (requestMethod === RequestMethod.POST ? 201 : 200);
        const marker = (Reflect.getMetadata(ROUTE_MARKER, handler) ?? Reflect.getMetadata(ROUTE_MARKER, controller)) as
          | RouteMarker
          | undefined;
        const doc = Reflect.getMetadata(API_DOC, handler) as ApiDocOptions | undefined;

        routes.push({ path: joinPath(base ?? '', path), method, status, marker, doc, handler });
      }
    }
  }
  return routes;
}

function accessLine(marker: RouteMarker | undefined): string {
  switch (marker?.kind) {
    case 'public':
      return 'Access: public.';
    case 'authenticated':
      return 'Access: any signed-in user.';
    case 'permission':
      return `Access: permission \`${marker.permission}\`.`;
    default:
      return 'Access: refused (the route has no access marker).';
  }
}

/** IdempotencyInterceptor covers POSTs made with a tenant token: tenant routes, not public or platform ones. */
function isTenantPost(route: DocumentedRoute): boolean {
  const { marker } = route;
  if (route.method !== 'post') return false;
  return marker?.kind === 'authenticated' || (marker?.kind === 'permission' && !marker.permission.startsWith('platform.'));
}

function fillOperation(operation: OperationObject, route: DocumentedRoute, ctx: DocContext): void {
  const { doc, marker } = route;
  const isPublic = marker?.kind === 'public';
  const idempotent = isTenantPost(route);
  operation.tags = [route.path.split('/')[1] ?? 'api'];
  operation.security = isPublic ? [] : [{ bearer: [] }];
  if (doc) {
    operation.summary = doc.summary;
  }
  operation.description = [doc?.description, idempotent ? IDEMPOTENCY_NOTE : undefined, accessLine(marker)]
    .filter(Boolean)
    .join('\n\n');

  if (doc?.body) {
    const body = typeof doc.body === 'function' ? doc.body(ctx) : doc.body;
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: zodToOpenApi(body) } },
    };
  } else {
    // Nest guesses an empty body from @Body(); without a schema, show none, so a missing one is noticed.
    delete operation.requestBody;
  }

  // Path parameters as Nest generated them. Query parameters come only from
  // `query`; headers read internally (such as Host) are not part of the API.
  const pathParameters = (operation.parameters ?? []).filter((parameter) => 'in' in parameter && parameter.in === 'path');
  const queryShape: z.core.$ZodShape = doc?.query?.shape ?? {};
  const queryParameters = Object.entries(queryShape).map(([name, field]) => ({
    name,
    in: 'query' as const,
    required: !z.safeParse(field, undefined).success,
    schema: zodToOpenApi(field),
  }));
  operation.parameters = [...pathParameters, ...queryParameters];

  const responses: ResponsesObject = {
    [route.status]: doc?.response
      ? {
          description: 'Success',
          content: { 'application/json': { schema: zodToOpenApi(doc.response, 'output') } },
        }
      : { description: route.status === 204 ? 'No content' : 'Success' },
  };
  // Derived like access: any protected route can refuse the token (401) or the caller (403, also a
  // suspended tenant or the wrong kind of token), and a reused Idempotency-Key is a 409.
  const derived = [...(isPublic ? [] : [401, 403]), ...(idempotent ? [409] : [])];
  const errors = [...new Set([...(doc?.errors ?? []), ...derived])].sort((a, b) => a - b);
  for (const status of errors) {
    responses[status] = {
      description: ERROR_DESCRIPTIONS[status] ?? 'Error',
      content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
    };
  }
  operation.responses = responses;
}

/**
 * The OpenAPI document: paths from @nestjs/swagger, then every operation
 * filled from the route's `@ApiDoc`, its access marker and its status code.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('ERP API')
    .setDescription('Made-to-order production ERP. Log in, paste the access token into Authorize, then try any endpoint.')
    .setVersion('0.0.1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, Problem: PROBLEM_SCHEMA },
  };

  const ctx: DocContext = { fileMaxBytes: app.get(ConfigService).get('FILE_MAX_BYTES') };
  for (const route of collectRoutes(app)) {
    const operation = (document.paths[route.path] as Record<string, OperationObject> | undefined)?.[route.method];
    if (operation) {
      fillOperation(operation, route, ctx);
    }
  }
  return document;
}
