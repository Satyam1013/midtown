import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Role } from '../enums';
import { Principal } from '../interfaces/principal';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';
export const HOIST_DATA = 'hoistData';

/** No token needed. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Allowed roles. A route without this is open to staff roles only, never to guests. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

/**
 * Also copies the data fields to the top level of the response. The manager
 * app reads accessToken / refreshToken from there on login and refresh.
 */
export const HoistData = () => SetMetadata(HOIST_DATA, true);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest().user,
);

/** The stay resolved by GuestStayGuard; always derived from the token. */
export const GuestStay = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().guestStay,
);
