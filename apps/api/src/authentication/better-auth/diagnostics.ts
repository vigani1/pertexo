import { AsyncLocalStorage } from 'node:async_hooks';
import type { StructuredLogger } from '@pertexo/observability/server';
import type { BetterAuthOptions } from 'better-auth';
import { createRequestContext } from '../../platform/http/request-context.js';

const flows = new Map([
  ['/request-password-reset', 'password_reset'],
  ['/sign-in/email', 'password_sign_in'],
  ['/sign-up/email', 'sign_up'],
]);

interface DiagnosticScope {
  requestId: string;
  flow: string;
  reported: boolean;
}

/** SDK messages and error arguments can contain SQL parameters and credentials. */
export class AuthenticationDiagnostics {
  readonly #scope = new AsyncLocalStorage<DiagnosticScope>();

  public constructor(private readonly logger: StructuredLogger) {}

  public readonly options = {
    logger: {
      level: 'warn',
      log: (level) => {
        if (level === 'warn' || level === 'error')
          this.report(level === 'error' ? 'internal_failure' : 'sdk_warning');
      },
    },
    // The router otherwise prints non-API errors directly to console after the hook.
    onAPIError: { throw: true },
  } satisfies Pick<BetterAuthOptions, 'logger' | 'onAPIError'>;

  public run<T>(request: Request, operation: () => T): T {
    const path = new URL(request.url).pathname.replace(/^\/v1\/auth/u, '');
    return this.#scope.run(
      {
        ...createRequestContext(request.headers.get('x-request-id')),
        flow: flows.get(path) ?? 'authentication',
        reported: false,
      },
      operation,
    );
  }

  public async response(operation: () => Promise<Response>): Promise<Response> {
    try {
      const response = await operation();
      if (response.status >= 500) this.report('internal_failure');
      return response;
    } catch {
      this.report('internal_failure');
      return new Response(null, { status: 500 });
    }
  }

  public passwordResetFailure(): void {
    this.report('internal_failure');
  }

  private report(reason: 'internal_failure' | 'sdk_warning'): void {
    const scope = this.#scope.getStore();
    if (scope?.reported) return;
    if (scope !== undefined) scope.reported = true;
    const fields = {
      requestId: scope?.requestId ?? createRequestContext().requestId,
      flow: scope?.flow ?? 'authentication',
      reason,
    };
    if (reason === 'sdk_warning')
      this.logger.warn('authentication.failed', fields);
    else this.logger.error('authentication.failed', fields);
  }
}
