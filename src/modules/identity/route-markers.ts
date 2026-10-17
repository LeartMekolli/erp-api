import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions';

/**
 * Every route carries exactly one marker; the guard denies a route with none
 * (spec 4.6). One metadata key for all three, so a second marker replaces the
 * first instead of combining with it.
 */
export const ROUTE_MARKER = 'identity:route-marker';

export type RouteMarker =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permission: Permission };

/** No token needed: login, refresh, invitation acceptance, health. */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata<string, RouteMarker>(ROUTE_MARKER, { kind: 'public' });

/** Any valid token, whatever it may do: logout, the caller's own identity. */
export const Authenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata<string, RouteMarker>(ROUTE_MARKER, { kind: 'authenticated' });

export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata<string, RouteMarker>(ROUTE_MARKER, { kind: 'permission', permission });
