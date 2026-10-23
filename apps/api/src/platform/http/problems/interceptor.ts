import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, throwError, type Observable } from 'rxjs';

/** Preserve an operation's meaning before the HTTP filter projects its error. */
export function domainErrors(
  normalize: (error: unknown) => unknown,
): NestInterceptor<unknown, unknown> {
  return {
    intercept(
      _context: ExecutionContext,
      next: CallHandler<unknown>,
    ): Observable<unknown> {
      return next
        .handle()
        .pipe(
          catchError((error: unknown) => throwError(() => normalize(error))),
        );
    },
  };
}
