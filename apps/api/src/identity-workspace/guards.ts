import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import {
  DoubleSubmitCsrfPolicy,
  OpaqueSessionService,
} from '../identity/index.js';
import { applicationError } from '../platform/http/index.js';
import {
  authorizeWorkspace,
  createActorContext,
  type AuthorizationCapability,
} from '../workspaces/index.js';
import type {
  IdentityWorkspaceRequest,
  AuthenticatedRequestSession,
} from './types.js';
import type { WorkspaceAuthorizationReader } from './ports.js';
import { mapIdentityWorkspaceError } from './errors.js';
import { requestIdentifier, traceIdentifier } from './request-identifiers.js';

export const SESSION_COOKIE_NAME = 'pertexo_session';
export const CSRF_COOKIE_NAME = 'pertexo_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

@Injectable()
export class SessionAuthenticationGuard implements CanActivate {
  public constructor(private readonly sessions: OpaqueSessionService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = requestFrom(context);
    const rawToken = readCookie(request, SESSION_COOKIE_NAME);
    if (rawToken === undefined) {
      return throwApplicationError(applicationError('auth.unauthenticated'));
    }
    try {
      request.identitySession = await this.sessions.authenticate(rawToken);
      return true;
    } catch (error: unknown) {
      return throwApplicationError(mapIdentityWorkspaceError(error));
    }
  }
}

@Injectable()
export class CsrfProtectionGuard implements CanActivate {
  public constructor(private readonly csrf: DoubleSubmitCsrfPolicy) {}

  public canActivate(context: ExecutionContext): boolean {
    const request = requestFrom(context);
    try {
      this.csrf.assertMutationAllowed({
        method: request.method ?? 'GET',
        ...optionalToken('cookieToken', readCookie(request, CSRF_COOKIE_NAME)),
        ...optionalToken('headerToken', readHeader(request, CSRF_HEADER_NAME)),
      });
      return true;
    } catch (error: unknown) {
      return throwApplicationError(mapIdentityWorkspaceError(error));
    }
  }
}

@Injectable()
export class WorkspaceCapabilityGuard implements CanActivate {
  public constructor(
    private readonly capability: AuthorizationCapability,
    private readonly authorization: WorkspaceAuthorizationReader,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = requestFrom(context);
    const session = request.identitySession;
    const routeWorkspaceId = routeWorkspace(request);
    if (session === undefined) {
      return throwApplicationError(applicationError('auth.unauthenticated'));
    }
    try {
      const actor = createActorContext({
        actorId: session.userId,
        workspaceId: routeWorkspaceId,
        sessionId: session.sessionId,
        requestId: requestIdentifier(request),
        ...traceFields(traceIdentifier(request)),
      });
      request.authorizedWorkspace = await authorizeWorkspace({
        actor,
        routeWorkspaceId,
        capability: this.capability,
        access: this.authorization,
        disclosure: 'not_found',
      });
      return true;
    } catch (error: unknown) {
      return throwApplicationError(mapIdentityWorkspaceError(error));
    }
  }
}

function requestFrom(context: ExecutionContext): IdentityWorkspaceRequest {
  return context.switchToHttp().getRequest<IdentityWorkspaceRequest>();
}

function routeWorkspace(request: IdentityWorkspaceRequest): string {
  const params = request.params;
  if (
    typeof params !== 'object' ||
    params === null ||
    !('workspaceId' in params) ||
    typeof params.workspaceId !== 'string'
  ) {
    return throwApplicationError(applicationError('request.invalid'));
  }
  return params.workspaceId;
}

export function readHeader(
  request: IdentityWorkspaceRequest,
  name: string,
): string | undefined {
  const headers = request.headers;
  if (headers === undefined) return undefined;
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  const value = key === undefined ? undefined : headers[key];
  return typeof value === 'string' ? value : value?.[0];
}

export function readCookie(
  request: IdentityWorkspaceRequest,
  name: string,
): string | undefined {
  const direct = request.cookies?.[name];
  if (direct !== undefined) return direct;
  const header = readHeader(request, 'cookie');
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

export function sessionToken(
  request: IdentityWorkspaceRequest,
): string | undefined {
  return readCookie(request, SESSION_COOKIE_NAME);
}

function optionalToken(
  key: 'cookieToken' | 'headerToken',
  value: string | undefined,
): Readonly<{ cookieToken?: string; headerToken?: string }> {
  return value === undefined ? {} : { [key]: value };
}

function traceFields(trace: string | undefined): Readonly<{
  traceId?: string;
}> {
  return trace === undefined ? {} : { traceId: trace };
}

export function authenticatedSession(
  request: IdentityWorkspaceRequest,
): AuthenticatedRequestSession {
  if (request.identitySession === undefined) {
    return throwApplicationError(applicationError('auth.unauthenticated'));
  }
  return request.identitySession;
}

function throwApplicationError(
  error: ReturnType<typeof applicationError>,
): never {
  // The HTTP platform deliberately accepts frozen application-error values.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw error;
}
