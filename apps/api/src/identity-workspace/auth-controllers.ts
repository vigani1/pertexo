import {
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import {
  CSRF_COOKIE_NAME,
  CsrfProtectionGuard,
  readCookie,
  SESSION_COOKIE_NAME,
  SessionAuthenticationGuard,
} from './guards.js';
import type { IdentitySessionAuthority, SessionCookiePolicy } from './ports.js';
import type { CookieResponse, IdentityWorkspaceRequest } from './types.js';
import {
  IDENTITY_WORKSPACE_TELEMETRY,
  SESSION_AUTHORITY,
  SESSION_COOKIE_POLICY,
} from './tokens.js';
import {
  IDENTITY_WORKSPACE_OPERATION,
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  type IdentityWorkspaceTelemetry,
} from './telemetry.js';

@Controller('v1/auth')
export class SessionController {
  public constructor(
    @Inject(SESSION_AUTHORITY)
    private readonly sessions: IdentitySessionAuthority,
    @Inject(SESSION_COOKIE_POLICY)
    private readonly cookiePolicy: SessionCookiePolicy,
    @Inject(IDENTITY_WORKSPACE_TELEMETRY)
    private readonly telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {}

  @Post('logout')
  @RateLimit('actor_mutation')
  @HttpCode(204)
  @UseGuards(SessionAuthenticationGuard, CsrfProtectionGuard)
  public async logout(
    @Req() request: IdentityWorkspaceRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<void> {
    const token = readCookie(request, SESSION_COOKIE_NAME);
    if (token === undefined)
      return throwApplicationError(applicationError('auth.unauthenticated'));
    await this.telemetry.measure(
      IDENTITY_WORKSPACE_OPERATION.sessionLogout,
      async () => {
        await this.sessions.revoke(token);
        response.header('set-cookie', [
          clearCookie(SESSION_COOKIE_NAME, true, this.cookiePolicy),
          clearCookie(CSRF_COOKIE_NAME, false, this.cookiePolicy),
        ]);
      },
    );
  }
}

function clearCookie(
  name: string,
  httpOnly: boolean,
  policy: SessionCookiePolicy,
): string {
  return [
    `${name}=`,
    'Path=/',
    'Max-Age=0',
    httpOnly ? 'HttpOnly' : undefined,
    policy.secure ? 'Secure' : undefined,
    `SameSite=${capitalize(policy.sameSite)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('; ');
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
