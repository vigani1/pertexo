import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
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
import { createActorContext } from '../workspaces/index.js';
import { applicationError } from '../platform/http/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { mapIdentityWorkspaceError } from './errors.js';
import type { SessionCookiePolicy } from './ports.js';
import {
  authenticatedSession,
  CSRF_COOKIE_NAME,
  CsrfProtectionGuard,
  OIDC_BROWSER_BINDING_COOKIE_NAME,
  readCookie,
  SESSION_COOKIE_NAME,
  SessionAuthenticationGuard,
  sessionToken,
  WorkspaceManageGuard,
} from './guards.js';
import {
  CreateWorkspaceUseCase,
  OidcApplicationService,
  WorkspaceLifecycleUseCase,
} from './use-cases.js';
import {
  idempotencyKeySchema,
  oidcCallbackRequestSchema,
  oidcStartResponseSchema,
  workspaceCreateRequestSchema,
  workspaceDeletionRequestSchema,
  workspaceIdParamSchema,
  workspaceLifecycleOperationParamsSchema,
  type CookieResponse,
  type IdentityWorkspaceRequest,
} from './types.js';
import { requestIdentifier, traceIdentifier } from './request-identifiers.js';
import {
  IDENTITY_WORKSPACE_TELEMETRY,
  SESSION_COOKIE_POLICY,
} from './tokens.js';
import {
  IDENTITY_WORKSPACE_OPERATION,
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  type IdentityWorkspaceTelemetry,
} from './telemetry.js';

export const OIDC_SESSION_RESPONSE = Object.freeze({
  status: 204,
});

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
    try {
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
    } catch (error: unknown) {
      return throwApplicationError(mapIdentityWorkspaceError(error));
    }
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
      const callback = oidcCallbackRequestSchema.parse(query);
      const cookies = new ResponseCookieBoundary(
        response,
        this.csrf.issueToken(),
        clearedBinding,
      );
      await this.application.complete(
        callback,
        readCookie(request, OIDC_BROWSER_BINDING_COOKIE_NAME),
        cookies,
      );
    } catch (error: unknown) {
      try {
        response.header('set-cookie', clearedBinding);
      } catch {
        // Preserve the original callback error if the response boundary failed.
      }
      return throwApplicationError(mapIdentityWorkspaceError(error));
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
  @RateLimit('ordinary_mutation')
  @HttpCode(204)
  @UseGuards(SessionAuthenticationGuard, CsrfProtectionGuard)
  public async logout(
    @Req() request: IdentityWorkspaceRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<void> {
    try {
      const token = sessionToken(request);
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
    } catch (error: unknown) {
      return throwApplicationError(mapIdentityWorkspaceError(error));
    }
  }
}

@Controller('v1/workspaces')
export class WorkspaceController {
  public constructor(
    private readonly createWorkspace: CreateWorkspaceUseCase,
    private readonly lifecycle: WorkspaceLifecycleUseCase,
  ) {}

  @Post()
  @RateLimit('ordinary_mutation')
  @UseGuards(SessionAuthenticationGuard, CsrfProtectionGuard)
  public async create(
    @Req() request: IdentityWorkspaceRequest,
    @Body() body: unknown,
  ) {
    try {
      const input = workspaceCreateRequestSchema.parse(body);
      const session = authenticatedSession(request);
      return await this.createWorkspace.execute({
        actorId: session.userId,
        idempotencyKey: requestIdempotencyKey(request),
        name: input.name,
        slug: input.slug,
        requestId: requestIdentifier(request),
        ...traceFields(traceIdentifier(request)),
      });
    } catch (error: unknown) {
      return throwApplicationError(mapIdentityWorkspaceError(error));
    }
  }

  @Post(':workspaceId/deletion')
  @RateLimit('ordinary_mutation')
  @HttpCode(202)
  @UseGuards(
    SessionAuthenticationGuard,
    CsrfProtectionGuard,
    WorkspaceManageGuard,
  )
  public async requestDeletion(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const { workspaceId } = workspaceIdParamSchema.parse(params);
      const deletion = workspaceDeletionRequestSchema.parse(body ?? {});
      const session = authenticatedSession(request);
      const requestId = requestIdentifier(request);
      const traceId = traceIdentifier(request);
      const actor = createActorContext({
        actorId: session.userId,
        workspaceId,
        sessionId: session.sessionId,
        requestId,
        ...traceFields(traceId),
      });
      return await this.lifecycle.requestDeletion({
        actor,
        idempotencyKey: requestIdempotencyKey(request),
        routeWorkspaceId: workspaceId,
        reason: deletion.reason,
        requestId,
        ...traceFields(traceId),
      });
    } catch (error: unknown) {
      return throwApplicationError(mapIdentityWorkspaceError(error));
    }
  }

  @Delete(':workspaceId/deletion')
  @RateLimit('ordinary_mutation')
  @HttpCode(202)
  @UseGuards(
    SessionAuthenticationGuard,
    CsrfProtectionGuard,
    WorkspaceManageGuard,
  )
  public async restore(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
  ) {
    try {
      const { workspaceId } = workspaceIdParamSchema.parse(params);
      const session = authenticatedSession(request);
      const requestId = requestIdentifier(request);
      const traceId = traceIdentifier(request);
      const actor = createActorContext({
        actorId: session.userId,
        workspaceId,
        sessionId: session.sessionId,
        requestId,
        ...traceFields(traceId),
      });
      return await this.lifecycle.restore({
        actor,
        idempotencyKey: requestIdempotencyKey(request),
        routeWorkspaceId: workspaceId,
        requestId,
        ...traceFields(traceId),
      });
    } catch (error: unknown) {
      return throwApplicationError(mapIdentityWorkspaceError(error));
    }
  }

  @Get(':workspaceId/lifecycle-operations/:operationId')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, WorkspaceManageGuard)
  public async readLifecycleOperation(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
  ) {
    try {
      const { workspaceId, operationId } =
        workspaceLifecycleOperationParamsSchema.parse(params);
      const session = authenticatedSession(request);
      const requestId = requestIdentifier(request);
      const traceId = traceIdentifier(request);
      const actor = createActorContext({
        actorId: session.userId,
        workspaceId,
        sessionId: session.sessionId,
        requestId,
        ...traceFields(traceId),
      });
      return await this.lifecycle.readOperation({
        actor,
        routeWorkspaceId: workspaceId,
        operationId,
      });
    } catch (error: unknown) {
      return throwApplicationError(mapIdentityWorkspaceError(error));
    }
  }
}

function requestIdempotencyKey(request: IdentityWorkspaceRequest): string {
  const entry = Object.entries(request.headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'idempotency-key',
  );
  return idempotencyKeySchema.parse(entry?.[1]);
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
      serializeCookie('pertexo_session', token, options),
      serializeCookie('pertexo_csrf', this.csrfToken, options, false),
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

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
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

function traceFields(trace: string | undefined): Readonly<{
  traceId?: string;
}> {
  return trace === undefined ? {} : { traceId: trace };
}

function throwApplicationError(
  error: ReturnType<typeof applicationError>,
): never {
  // The HTTP problem filter deliberately accepts frozen application-error values.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw error;
}
