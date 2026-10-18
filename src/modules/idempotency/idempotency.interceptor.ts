import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, catchError, from, mergeMap, of, throwError } from 'rxjs';
import { authOfRequest } from '../identity/auth-context';
import { fingerprint } from './fingerprint';
import { IdempotencyService } from './idempotency.service';

/** Visible ASCII, 1–255 characters. */
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/**
 * Honours `Idempotency-Key` on tenant-scoped POSTs (ADR 0005.2, plan I1). A
 * repeat with the same key and request replays the stored response; the same
 * key with another request is a 409. Only successful responses are stored:
 * a failure releases the key, so the client can fix the request and retry.
 * Public and platform routes ignore the header.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly store: IdempotencyService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const header = request.headers['idempotency-key'];
    const auth = authOfRequest(request);

    if (request.method !== 'POST' || header === undefined || auth?.scope !== 'tenant') {
      return next.handle();
    }
    if (typeof header !== 'string' || !KEY_PATTERN.test(header)) {
      throw new BadRequestException('Idempotency-Key must be 1–255 visible ASCII characters');
    }

    const { tenantId } = auth;
    const requestFingerprint = fingerprint({
      userId: auth.userId,
      method: request.method,
      path: request.path,
      body: request.body,
    });

    const begun = await this.store.begin(tenantId, header, requestFingerprint);
    if (begun.kind === 'replay') {
      response.status(begun.status);
      response.setHeader('Idempotent-Replayed', 'true');
      return of(begun.body);
    }

    // Nest sets the status after interceptors run, so read what it will be.
    const status = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ?? HttpStatus.CREATED;

    return next.handle().pipe(
      mergeMap(async (body: unknown) => {
        await this.store.complete(tenantId, header, requestFingerprint, status, body);
        return body;
      }),
      catchError((error: unknown) =>
        from(this.store.release(tenantId, header)).pipe(mergeMap(() => throwError(() => error))),
      ),
    );
  }
}
