import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import {
  DoubleSubmitCsrfPolicy,
  OidcLoginService,
  OpaqueSessionService,
  type SessionCookieOptions,
} from '../identity/index.js';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import {
  CSRF_COOKIE_NAME,
  CsrfProtectionGuard,
  OIDC_BROWSER_BINDING_COOKIE_NAME,
  readCookie,
  SESSION_COOKIE_NAME,
  SessionAuthenticationGuard,
} from './guards.js';
import type { SessionCookiePolicy } from './ports.js';
import {
  oidcStartResponseSchema,
  type CookieResponse,
  type IdentityWorkspaceRequest,
} from './types.js';
import {
  IDENTITY_WORKSPACE_TELEMETRY,
  SESSION_COOKIE_POLICY,
} from './tokens.js';
import {
  IDENTITY_WORKSPACE_OPERATION,
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  type IdentityWorkspaceTelemetry,
} from './telemetry.js';
import { OidcApplicationService } from './use-cases.js';

@Controller('v1/auth/oidc')
export class OidcController {
  private readonly application: OidcApplicationService;

  public constructor(
    oidc: OidcLoginService,
    sessions: OpaqueSessionService,
    private readonly csrf: DoubleSubmitCsrfPolicy,
    @Inject(SESSION_COOKIE_POLICY)
    private readonly cookiePolicy: SessionCookiePolicy,
    @Inject(IDENTITY_WORKSPACE_TELEMETRY)
    telemetry: IdentityWorkspaceTelemetry = NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  ) {
    this.application = new OidcApplicationService(oidc, sessions, telemetry);
  }

  @Get('start')
  @RateLimit('identity_start')
  public async start(
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<Readonly<{ authorizationUrl: string; expiresAt: string }>> {
    const result = await this.application.start();
    response.header(
      'set-cookie',
      serializeOidcBindingCookie(
        result.browserBinding,
        result.expiresAt,
        result.browserBindingMaxAgeSeconds,
        this.cookiePolicy,
      ),
    );
    return oidcStartResponseSchema.parse({
      authorizationUrl: result.authorizationUrl,
      expiresAt: result.expiresAt.toISOString(),
    });
  }

  @Get('callback')
  @RateLimit('identity_callback')
  @HttpCode(204)
  public async callback(
    @Query() query: unknown,
    @Req() request: IdentityWorkspaceRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<void> {
    const clearedBinding = clearOidcBindingCookie(this.cookiePolicy);
    try {
      const cookies = new ResponseCookieBoundary(
        response,
        this.csrf.issueToken(),
        clearedBinding,
      );
      await this.application.complete(
        query,
        readCookie(request, OIDC_BROWSER_BINDING_COOKIE_NAME),
        cookies,
      );
    } catch (error: unknown) {
      try {
        response.header('set-cookie', clearedBinding);
      } catch {
        // Preserve the original callback error if the response boundary failed.
      }
      throw error;
    }
  }
}

@Controller('v1/auth')
export class SessionController {
  public constructor(
    private readonly sessions: OpaqueSessionService,
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

class ResponseCookieBoundary {
  public constructor(
    private readonly response: CookieResponse,
    private readonly csrfToken: string,
    private readonly clearedOidcBinding: string,
  ) {}

  public writeSessionCookie(
    token: string,
    options: SessionCookieOptions,
  ): void {
    this.response.header('set-cookie', [
      this.clearedOidcBinding,
      serializeCookie(SESSION_COOKIE_NAME, token, options),
      serializeCookie(CSRF_COOKIE_NAME, this.csrfToken, options, false),
    ]);
  }
}

const OIDC_CALLBACK_COOKIE_PATH = '/v1/auth/oidc/callback';

function serializeOidcBindingCookie(
  value: string,
  expiresAt: Date,
  maxAgeSeconds: number,
  policy: SessionCookiePolicy,
): string {
  return [
    `${OIDC_BROWSER_BINDING_COOKIE_NAME}=${encodeURIComponent(value)}`,
    `Path=${OIDC_CALLBACK_COOKIE_PATH}`,
    'HttpOnly',
    policy.secure ? 'Secure' : undefined,
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${String(maxAgeSeconds)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('; ');
}

function clearOidcBindingCookie(policy: SessionCookiePolicy): string {
  return [
    `${OIDC_BROWSER_BINDING_COOKIE_NAME}=`,
    `Path=${OIDC_CALLBACK_COOKIE_PATH}`,
    'Max-Age=0',
    'HttpOnly',
    policy.secure ? 'Secure' : undefined,
    'SameSite=Lax',
  ]
    .filter((part): part is string => part !== undefined)
    .join('; ');
}

function serializeCookie(
  name: string,
  value: string,
  options: SessionCookieOptions,
  httpOnly = true,
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    httpOnly ? 'HttpOnly' : undefined,
    options.secure ? 'Secure' : undefined,
    `SameSite=${capitalize(options.sameSite)}`,
    `Max-Age=${String(options.maxAgeSeconds)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('; ');
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
