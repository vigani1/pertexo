import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import {
  DoubleSubmitCsrfPolicy,
  OpaqueSessionService,
} from '../identity/index.js';
import {
  throwApplicationError,
  applicationError,
} from '../platform/http/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import {
  CSRF_COOKIE_NAME,
  CsrfProtectionGuard,
  OIDC_BROWSER_BINDING_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SessionAuthenticationGuard,
  authenticatedSession,
  readCookie,
  readHeader,
} from './guards.js';
import { InvitationAcceptanceUseCase } from './invitation-acceptance-use-case.js';
import type { IdentitySessionAuthority, SessionCookiePolicy } from './ports.js';
import { requestIdentifier, traceIdentifier } from './request-identifiers.js';
import { INVITATION_ALLOWED_ORIGIN, SESSION_COOKIE_POLICY } from './tokens.js';
import type { CookieResponse, IdentityWorkspaceRequest } from './types.js';
import { Inject } from '@nestjs/common';

const INVITATION_BINDING_COOKIE_NAME = 'pertexo_invitation_intent';
const INVITATION_CSRF_HEADER = 'x-invitation-csrf-token';

@Controller('v1/invitation-acceptance')
export class InvitationAcceptanceController {
  public constructor(
    private readonly acceptance: InvitationAcceptanceUseCase,
    @Inject(OpaqueSessionService)
    private readonly sessions: IdentitySessionAuthority,
    private readonly csrf: DoubleSubmitCsrfPolicy,
    @Inject(SESSION_COOKIE_POLICY)
    private readonly cookiePolicy: SessionCookiePolicy,
    @Inject(INVITATION_ALLOWED_ORIGIN)
    private readonly allowedOrigin: string,
  ) {}

  @Post('resolve')
  @HttpCode(201)
  @RateLimit('identity_start')
  public async resolve(
    @Req() request: IdentityWorkspaceRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    requireResolveBoundary(request, this.allowedOrigin);
    const result = await this.acceptance.resolve(
      body,
      readCookie(request, INVITATION_BINDING_COOKIE_NAME),
    );
    response.header('Cache-Control', 'no-store');
    if (result.binding !== undefined)
      response.header(
        'set-cookie',
        serializeBindingCookie(result.binding, this.cookiePolicy),
      );
    return result.journey;
  }

  @Get()
  @RateLimit('identity_start')
  public async read(
    @Req() request: IdentityWorkspaceRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    response.header('Cache-Control', 'no-store');
    return this.acceptance.read(
      readCookie(request, INVITATION_BINDING_COOKIE_NAME),
      await optionalUserId(request, this.sessions),
    );
  }

  /**
   * Verifies the invited account from a fresh sign-in by the active session
   * authority (ADR 043), for deployments whose sign-in is not legacy OIDC.
   */
  @Post('session')
  @HttpCode(200)
  @RateLimit('identity_start')
  @UseGuards(SessionAuthenticationGuard, CsrfProtectionGuard)
  public async verifySession(
    @Req() request: IdentityWorkspaceRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    requireEmptyBody(body);
    const evidence = await this.sessions.signInEvidence?.(
      readCookie(request, SESSION_COOKIE_NAME) ?? '',
    );
    if (evidence?.userId !== authenticatedSession(request).userId)
      return throwApplicationError(
        applicationError(
          evidence === undefined
            ? 'resource.not_found'
            : 'auth.unauthenticated',
        ),
      );
    response.header('Cache-Control', 'no-store');
    return this.acceptance.recordSessionProof({
      binding: readCookie(request, INVITATION_BINDING_COOKIE_NAME),
      csrfToken: readHeader(request, INVITATION_CSRF_HEADER),
      evidence,
    });
  }

  @Post('complete')
  @HttpCode(200)
  @RateLimit('ordinary_mutation')
  @UseGuards(SessionAuthenticationGuard, CsrfProtectionGuard)
  public async complete(
    @Req() request: IdentityWorkspaceRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    const userAgent = readHeader(request, 'user-agent');
    const traceId = traceIdentifier(request);
    const result = await this.acceptance.complete({
      binding: readCookie(request, INVITATION_BINDING_COOKIE_NAME),
      csrfToken: readHeader(request, INVITATION_CSRF_HEADER),
      authenticatedUserId: authenticatedSession(request).userId,
      request: body,
      idempotencyKey: requiredHeader(request, 'idempotency-key'),
      ...(userAgent === undefined ? {} : { userAgent }),
      requestId: requestIdentifier(request),
      ...(traceId === undefined ? {} : { traceId }),
    });
    response.header('Cache-Control', 'no-store');
    const cookies: string[] = [];
    if (
      result.replacementToken !== undefined &&
      result.replacementExpiresAt !== undefined
    ) {
      const csrfToken = this.csrf.issueToken();
      if (this.sessions.deliver === undefined) {
        cookies.push(
          serializeSessionCookie(
            SESSION_COOKIE_NAME,
            result.replacementToken,
            result.replacementExpiresAt,
            true,
            this.cookiePolicy,
          ),
        );
      } else {
        await this.sessions.deliver(result.replacementToken, {
          writeSessionCookie: () => undefined,
          writeSessionCookieHeaders: (setCookies) => {
            cookies.push(...setCookies);
          },
        });
      }
      cookies.push(
        serializeSessionCookie(
          CSRF_COOKIE_NAME,
          csrfToken,
          result.replacementExpiresAt,
          false,
          this.cookiePolicy,
        ),
      );
    }
    if (cookies.length > 0) response.header('set-cookie', cookies);
    return result.receipt;
  }

  @Delete()
  @HttpCode(204)
  @RateLimit('identity_start')
  public async abandon(
    @Req() request: IdentityWorkspaceRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<void> {
    await this.acceptance.abandon(
      readCookie(request, INVITATION_BINDING_COOKIE_NAME),
      readHeader(request, INVITATION_CSRF_HEADER),
    );
    response.header('Cache-Control', 'no-store');
    response.header('set-cookie', clearBindingCookie(this.cookiePolicy));
  }
}

/** Legacy OIDC verification, registered only when OIDC is configured. */
@Controller('v1/invitation-acceptance')
export class InvitationAcceptanceOidcController {
  public constructor(
    private readonly acceptance: InvitationAcceptanceUseCase,
    @Inject(SESSION_COOKIE_POLICY)
    private readonly cookiePolicy: SessionCookiePolicy,
  ) {}

  @Post('oidc')
  @HttpCode(200)
  @RateLimit('identity_start')
  public async oidc(
    @Req() request: IdentityWorkspaceRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    requireEmptyBody(body);
    const result = await this.acceptance.startOidc(
      readCookie(request, INVITATION_BINDING_COOKIE_NAME),
      readHeader(request, INVITATION_CSRF_HEADER),
    );
    response.header('Cache-Control', 'no-store');
    response.header(
      'set-cookie',
      serializeOidcBindingCookie(
        result.oidcBinding,
        result.oidcBindingExpiresAt,
        result.oidcBindingMaxAgeSeconds,
        this.cookiePolicy,
      ),
    );
    return result.response;
  }
}

function requireEmptyBody(body: unknown): void {
  if (
    body === null ||
    typeof body !== 'object' ||
    Object.keys(body).length !== 0
  )
    throwApplicationError(applicationError('request.invalid'));
}

async function optionalUserId(
  request: IdentityWorkspaceRequest,
  sessions: IdentitySessionAuthority,
): Promise<string | undefined> {
  const raw = readCookie(request, SESSION_COOKIE_NAME);
  if (raw === undefined) return undefined;
  try {
    return (await sessions.authenticate(raw)).userId;
  } catch {
    return undefined;
  }
}

function requireResolveBoundary(
  request: IdentityWorkspaceRequest,
  allowedOrigin: string,
): void {
  if (
    readHeader(request, 'x-pertexo-invitation-request') !== 'resolve' ||
    readHeader(request, 'origin') !== allowedOrigin ||
    !readHeader(request, 'content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    throwApplicationError(applicationError('auth.forbidden'));
}

function requiredHeader(
  request: IdentityWorkspaceRequest,
  name: string,
): string {
  const value = readHeader(request, name);
  if (value === undefined)
    return throwApplicationError(applicationError('request.invalid'));
  return value;
}

function serializeBindingCookie(
  value: string,
  policy: SessionCookiePolicy,
): string {
  return [
    `${INVITATION_BINDING_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    policy.secure ? 'Secure' : undefined,
    `SameSite=${capitalize(policy.sameSite)}`,
    `Max-Age=${String(15 * 60)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('; ');
}

function clearBindingCookie(policy: SessionCookiePolicy): string {
  return [
    `${INVITATION_BINDING_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    policy.secure ? 'Secure' : undefined,
    `SameSite=${capitalize(policy.sameSite)}`,
    'Max-Age=0',
  ]
    .filter((part): part is string => part !== undefined)
    .join('; ');
}

function serializeOidcBindingCookie(
  value: string,
  expiresAt: Date,
  maxAgeSeconds: number,
  policy: SessionCookiePolicy,
): string {
  return [
    `${OIDC_BROWSER_BINDING_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/v1/auth/oidc/callback',
    'HttpOnly',
    policy.secure ? 'Secure' : undefined,
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${String(maxAgeSeconds)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('; ');
}

function serializeSessionCookie(
  name: string,
  value: string,
  expiresAt: Date,
  httpOnly: boolean,
  policy: SessionCookiePolicy,
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    httpOnly ? 'HttpOnly' : undefined,
    policy.secure ? 'Secure' : undefined,
    `SameSite=${capitalize(policy.sameSite)}`,
    `Max-Age=${String(Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1_000)))}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('; ');
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
