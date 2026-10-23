import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { CustomerRole } from '../customers/customer-roles';
import type { PlatformPermission, TenantPermission } from './permissions';

export interface TenantAuth {
  scope: 'tenant';
  tenantId: string;
  userId: string;
  jti: string;
  expiresAt: Date;
  permissions: ReadonlySet<TenantPermission>;
}

export interface PlatformAuth {
  scope: 'platform';
  platformAdminId: string;
  jti: string;
  expiresAt: Date;
  permissions: ReadonlySet<PlatformPermission>;
}

export type AuthContext = TenantAuth | PlatformAuth;

/** A customer person acting for one customer, set by the guard on `CustomerAccess` routes. */
export interface CustomerAuth {
  tenantId: string;
  userId: string;
  customerId: string;
  role: CustomerRole;
}

/** Set by the guard, read by the decorators below. */
const authByRequest = new WeakMap<IncomingMessage, AuthContext>();

export function setAuth(request: IncomingMessage, auth: AuthContext): void {
  authByRequest.set(request, auth);
}

const customerAuthByRequest = new WeakMap<IncomingMessage, CustomerAuth>();

export function setCustomerAuth(request: IncomingMessage, auth: CustomerAuth): void {
  customerAuthByRequest.set(request, auth);
}

/** The verified caller, if the guard authenticated this request. */
export function authOfRequest(request: IncomingMessage): AuthContext | undefined {
  return authByRequest.get(request);
}

function authOf(context: ExecutionContext): AuthContext {
  const auth = authByRequest.get(context.switchToHttp().getRequest<IncomingMessage>());
  if (!auth) {
    // Only reachable on a @Public() route, which has no caller to inject.
    throw new UnauthorizedException();
  }
  return auth;
}

function tenantAuthOf(context: ExecutionContext): TenantAuth {
  const auth = authOf(context);
  if (auth.scope !== 'tenant') {
    throw new ForbiddenException('This route acts within a tenant');
  }
  return auth;
}

export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  authOf(context),
);

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  tenantAuthOf(context),
);

/**
 * The tenant for `prisma.inTenant`, taken from the verified token and nowhere
 * else (ADR 0001).
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => tenantAuthOf(context).tenantId,
);

export const CurrentPlatformAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const auth = authOf(context);
    if (auth.scope !== 'platform') {
      throw new ForbiddenException('This route is for platform admins');
    }
    return auth;
  },
);

/** The customer the caller acts for, on a `CustomerAccess` route only. */
export const CurrentCustomer = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const auth = customerAuthByRequest.get(context.switchToHttp().getRequest<IncomingMessage>());
  if (!auth) {
    // Only reachable on a route without the CustomerAccess marker.
    throw new ForbiddenException('This route acts for a customer');
  }
  return auth;
});
