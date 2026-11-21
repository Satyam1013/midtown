import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { OPEN_DAY_ONLY, OpenDayRule } from '../common/decorators';
import { Role } from '../common/enums';
import { pastDateRestricted } from '../common/errors';
import { DaybookService } from './daybook.service';

/**
 * Enforces @OpenDayOnly: non-admin staff read and change only the open
 * business day. Runs before validation, so a defaulted date is validated like
 * one the app sent. The role comes from the verified principal, never the request.
 */
@Injectable()
export class OpenDayInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly daybook: DaybookService,
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const rule = this.reflector.get<OpenDayRule | undefined>(OPEN_DAY_ONLY, ctx.getHandler());
    if (!rule) return next.handle();
    const req = ctx.switchToHttp().getRequest();
    if (req.user?.role === Role.ADMIN) return next.handle();

    const open = await this.daybook.openDate();
    if (rule.body) {
      if (!open || req.body?.[rule.body] !== open) throw pastDateRestricted();
    }
    if (rule.query) {
      const query: Record<string, unknown> = { ...req.query };
      const asked = rule.query.map((f) => query[f]).filter((v) => v !== undefined && v !== '');
      if (!open) {
        if (rule.empty) return of(rule.empty());
        throw pastDateRestricted();
      }
      if (asked.some((v) => v !== open)) throw pastDateRestricted();
      for (const f of rule.query) query[f] = open;
      // Express 5 exposes req.query as a getter; shadow it on this request.
      Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true, enumerable: true });
    }
    return next.handle();
  }
}
