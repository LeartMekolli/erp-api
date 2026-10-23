import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { z } from 'zod';
import { requestContextOf } from '../../common/request-context/request-context';
import { PrismaService } from '../../database/prisma.service';
import { AccessClaims, AccessTokenService } from './access-token.service';
import { CUSTOMER_ROLES, atLeast } from '../customers/customer-roles';
import type { CustomerRole } from '../customers/customer-roles';
import { AuthContext, PlatformAuth, TenantAuth, setAuth, setCustomerAuth } from './auth-context';
import { PLATFORM_PERMISSIONS, TenantPermission, isTenantPermission } from './permissions';
import { ROUTE_MARKER, RouteMarker } from './route-markers';

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer (\S+)$/.exec(header ?? '');
  return match?.[1];
}

/**
 * Registered globally. Deny by default: a route without a marker is refused
 * even to an owner (spec 4.6, 8.4).
 *
 * The caller's status and permissions are read from the database on every
 * request rather than trusted from the token, so a deactivation, suspension or
 * role change applies to the next request, not after the token expires.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const marker = this.reflector.getAllAndOverride<RouteMarker | undefined>(ROUTE_MARKER, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (marker?.kind === 'public') {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException();
    }

    const claims = await this.tokens.verify(token);
    if (await this.tokens.isDenied(claims.jti)) {
      throw new UnauthorizedException();
    }

    const auth = claims.tid ? await this.tenantAuth(claims, claims.tid) : await this.platformAuth(claims);
    setAuth(request, auth);
    this.annotateRequestContext(request, auth);

    if (!marker) {
      throw new ForbiddenException('This route has no access rule');
    }
    if (marker.kind === 'permission' && !(auth.permissions as ReadonlySet<string>).has(marker.permission)) {
      throw new ForbiddenException();
    }
    if (marker.kind === 'customer') {
      await this.customerAuth(request, auth, marker.role);
    }

    return true;
  }

  /**
   * The caller must be a customer person with a membership in the route's
   * customer, which must be active, read fresh like the user's own status.
   * Another organisation's id, a removed membership and a disabled customer
   * all look the same: not found.
   */
  private async customerAuth(request: Request, auth: AuthContext, required: CustomerRole): Promise<void> {
    if (auth.scope !== 'tenant') {
      throw new ForbiddenException('This route acts for a customer');
    }
    const customerId = z.uuid().safeParse(request.params.customerId);
    if (!customerId.success) {
      throw new BadRequestException('customerId must be a UUID');
    }

    const found = await this.prisma.inTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { kind: true } });
      const membership = await tx.organisationMembership.findFirst({
        where: { userId: auth.userId, organisationType: 'customer', organisationId: customerId.data },
        select: { role: true },
      });
      const customer = await tx.customer.findUnique({ where: { id: customerId.data }, select: { status: true } });
      return { kind: user?.kind, role: membership?.role, status: customer?.status };
    });

    if (found.kind !== 'customer') {
      throw new ForbiddenException('This route is for customer people');
    }
    const role = CUSTOMER_ROLES.find((known) => known === found.role);
    if (!role || found.status !== 'active') {
      throw new NotFoundException('Customer not found');
    }
    if (!atLeast(role, required)) {
      throw new ForbiddenException();
    }

    setCustomerAuth(request, { tenantId: auth.tenantId, userId: auth.userId, customerId: customerId.data, role });
  }

  private async tenantAuth(claims: AccessClaims, tenantId: string): Promise<TenantAuth> {
    const user = await this.prisma.inTenant(tenantId, (tx) =>
      tx.user.findUnique({
        where: { id: claims.sub },
        select: {
          status: true,
          tenant: { select: { status: true } },
          roles: { select: { role: { select: { permissions: { select: { permission: true } } } } } },
        },
      }),
    );

    if (!user || user.status !== 'active') {
      throw new UnauthorizedException();
    }
    if (user.tenant.status !== 'active') {
      throw new ForbiddenException('Tenant is suspended');
    }

    const permissions = new Set<TenantPermission>();
    for (const { role } of user.roles) {
      for (const { permission } of role.permissions) {
        // A key removed from the code constant stops granting anything.
        if (isTenantPermission(permission)) permissions.add(permission);
      }
    }

    return {
      scope: 'tenant',
      tenantId,
      userId: claims.sub,
      jti: claims.jti,
      expiresAt: new Date(claims.exp * 1000),
      permissions,
    };
  }

  private async platformAuth(claims: AccessClaims): Promise<PlatformAuth> {
    const admin = await this.prisma.platformAdmin.findUnique({
      where: { id: claims.sub },
      select: { status: true },
    });

    if (!admin || admin.status !== 'active') {
      throw new UnauthorizedException();
    }

    return {
      scope: 'platform',
      platformAdminId: claims.sub,
      jti: claims.jti,
      expiresAt: new Date(claims.exp * 1000),
      permissions: new Set(PLATFORM_PERMISSIONS),
    };
  }

  /** For logs and error reports only; authorization never reads it back. */
  private annotateRequestContext(request: Request, auth: AuthContext): void {
    const context = requestContextOf(request);
    if (!context) return;
    if (auth.scope === 'tenant') {
      context.tenantId = auth.tenantId;
      context.userId = auth.userId;
    } else {
      context.userId = auth.platformAdminId;
    }
  }
}
