import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { GuestScopeService } from '../../auth/guest-scope.service';

/** Resolves the caller's stay from the token and exposes it through @GuestStay(). */
@Injectable()
export class GuestStayGuard implements CanActivate {
  constructor(private readonly scope: GuestScopeService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    req.guestStay = await this.scope.stayOf(req.user);
    return true;
  }
}
