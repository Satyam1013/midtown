import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC, ROLES } from '../decorators';
import { ALL_STAFF, Role } from '../enums';
import { forbidden } from '../errors';

// Deny by default: a route with no @Roles is staff-only, so forgetting the
// decorator can never expose a manager endpoint to a guest token.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const allowed = this.reflector.getAllAndOverride<Role[]>(ROLES, targets) ?? ALL_STAFF;
    if (!allowed.includes(ctx.switchToHttp().getRequest().user?.role)) {
      throw forbidden('FORBIDDEN', 'You do not have permission to do this');
    }
    return true;
  }
}
