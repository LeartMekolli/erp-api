import { SetMetadata } from '@nestjs/common';
import type { CustomerRole } from '../customers/customer-roles';
import type { PartnerRole } from '../partners/partner-roles';
import type { Permission } from './permissions';

/**
 * Every route carries exactly one marker; the guard denies a route with none
 * (spec 4.6). One metadata key for all of them, so a second marker replaces the
 * first instead of combining with it.
 */
export const ROUTE_MARKER = 'identity:route-marker';

export type RouteMarker =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permission: Permission }
  | { kind: 'customer'; role: CustomerRole }
  | { kind: 'partner'; role: PartnerRole }
  | { kind: 'partner_person' };

/** No token needed: login, refresh, invitation acceptance, health. */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata<string, RouteMarker>(ROUTE_MARKER, { kind: 'public' });

/** Any valid token, whatever it may do: logout, the caller's own identity. */
export const Authenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata<string, RouteMarker>(ROUTE_MARKER, { kind: 'authenticated' });

export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata<string, RouteMarker>(ROUTE_MARKER, { kind: 'permission', permission });

/**
 * A portal route: the caller is a customer person acting for the route's
 * `:customerId`, with at least `role` there (Customers spec). No membership,
 * or a disabled customer, is a 404; a lower role is a 403.
 */
export const CustomerAccess = (role: CustomerRole): MethodDecorator & ClassDecorator =>
  SetMetadata<string, RouteMarker>(ROUTE_MARKER, { kind: 'customer', role });

/**
 * A partner portal route: the caller is a partner person acting for the
 * route's `:partnerId`, with at least `role` there (Partners spec, goal 1).
 * No membership is a 404; a lower role is a 403. A suspended partner may
 * still read, so it can see and finish its jobs, but every other method is a 403.
 */
export const PartnerAccess = (role: PartnerRole): MethodDecorator & ClassDecorator =>
  SetMetadata<string, RouteMarker>(ROUTE_MARKER, { kind: 'partner', role });

/** Any partner person, whatever partners they act for: their own identity in the partner portal. */
export const PartnerPerson = (): MethodDecorator & ClassDecorator =>
  SetMetadata<string, RouteMarker>(ROUTE_MARKER, { kind: 'partner_person' });
