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

/** ADMIN only (requireRole('ADMIN')): 403 FORBIDDEN "Admin access required" for anyone else. */
export const AdminOnly = () => SetMetadata(ROLES, [Role.ADMIN]);

/**
 * Manager and other non-admin staff see only the open business day: the route's
 * `date` / `businessDate` / `from` / `to` must be that day (403
 * PAST_DATE_RESTRICTED otherwise) and default to it. With no day open the
 * route answers `empty()` without running. ADMIN is not restricted.
 */
export const OPEN_DAY_ONLY = 'openDayOnly';
export interface OpenDayRule {
  /** Query fields holding a date; each defaults to the open day when missing. */
  query?: ('date' | 'businessDate' | 'from' | 'to')[];
  /** Body field holding the date a write applies to; it must be the open day. */
  body?: 'businessDate';
  /** What a read answers when no day is open. Without it the route gets 403. */
  empty?: () => unknown;
}
export const OpenDayOnly = (rule: OpenDayRule) => SetMetadata(OPEN_DAY_ONLY, rule);

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
