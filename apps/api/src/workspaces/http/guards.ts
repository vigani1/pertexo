import { hasAuthorizationHeader } from '../../authentication/automation/headers.js';
import type { AuthorizationHeaderSource } from '../../authentication/automation/headers.js';
import { Inject, Injectable, mixin } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import { DoubleSubmitCsrfPolicy } from '../../identity/index.js';
import {
  applicationError,
  throwApplicationError,
  RequestContextStore,
} from '../../platform/http/index.js';
import { firstRequestHeader } from '../../platform/http/request-headers.js';
import {
  authorizeWorkspace,
  assertAuthorizedWorkspaceContext,
  BROWSABLE_WORKSPACE_STATUSES,
  createActorContext,
  isCanonicalUuid,
  type AuthorizationCapability,
  type WorkspaceStatus,
} from '../../authorization/index.js';
import type {
  IdentityWorkspaceRequest,
  AuthenticatedRequestSession,
} from '../types.js';
import type {
  IdentitySessionAuthority,
  WorkspaceAuthorizationSource,
} from '../ports.js';
import type { SignInEvidence } from '../../identity/index.js';

import { requestIdentifier, traceIdentifier } from '../request/identifiers.js';
import { SESSION_AUTHORITY, WORKSPACE_AUTHORIZATION } from '../tokens.js';

export const SESSION_COOKIE_NAME = 'pertexo_session';
export const CSRF_COOKIE_NAME = 'pertexo_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';

@Injectable()
export class SessionAuthenticationGuard implements CanActivate {
  public constructor(
    @Inject(SESSION_AUTHORITY)
    private readonly sessions: IdentitySessionAuthority,
    private readonly contexts: RequestContextStore,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = requestFrom(context);
    if (hasAuthorizationHeader(request.headers, request.raw?.rawHeaders))
      return throwApplicationError(applicationError('auth.unauthenticated'));
    const rawToken = readCookie(request, SESSION_COOKIE_NAME);
    if (rawToken === undefined) {
      return throwApplicationError(applicationError('auth.unauthenticated'));
    }
    const session = await this.sessions.authenticate(rawToken);
    request.identitySession = session;
    request.reauthorizeIdentitySession = (signal) =>
      this.sessions.authenticate(rawToken, { signal });
    this.contexts.setActor({
      actorId: session.userId,
      kind: 'user',
      credentialId: session.sessionId,
    });
    return true;
  }
}

@Injectable()
export class CsrfProtectionGuard implements CanActivate {
  public constructor(private readonly csrf: DoubleSubmitCsrfPolicy) {}

  public canActivate(context: ExecutionContext): boolean {
    return this.assertRequestAllowed(requestFrom(context));
  }

  public assertRequestAllowed(
    request: IdentityWorkspaceRequest,
    suppliedToken = firstRequestHeader(request.headers, CSRF_HEADER_NAME),
  ): boolean {
    const authorization = request.authorizedWorkspace;
    if (
      authorization?.actor.kind === 'api_key' &&
      request.apiTokenActor !== undefined
    ) {
      assertAuthorizedWorkspaceContext({
        context: authorization,
        actor: request.apiTokenActor,
        routeWorkspaceId: authorization.workspaceId,
        capability: authorization.capability,
      });
      return true;
    }
    this.csrf.assertMutationAllowed({
      method: request.method ?? 'GET',
      ...optionalToken('cookieToken', readCookie(request, CSRF_COOKIE_NAME)),
      ...optionalToken('headerToken', suppliedToken),
    });
    return true;
  }
}

class WorkspaceCapabilityGuard implements CanActivate {
  private readonly contexts: RequestContextStore;
  private readonly disclosure: 'forbidden' | 'not_found';
  private readonly allowedWorkspaceStatuses: readonly WorkspaceStatus[];
  public constructor(
    private readonly capability: AuthorizationCapability,
    private readonly authorization: WorkspaceAuthorizationSource,
    {
      contexts,
      disclosure = 'not_found',
      allowedWorkspaceStatuses = ['active'],
    }: Readonly<{
      contexts: RequestContextStore;
      disclosure?: ('forbidden' | 'not_found') | undefined;
      allowedWorkspaceStatuses?: readonly WorkspaceStatus[] | undefined;
    }>,
  ) {
    this.contexts = contexts;
    this.disclosure = disclosure;
    this.allowedWorkspaceStatuses = allowedWorkspaceStatuses;
  }

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = requestFrom(context);
    const session = request.identitySession;
    const routeWorkspaceId = routeWorkspace(request);
    if (session === undefined && request.apiTokenActor === undefined) {
      return throwApplicationError(applicationError('auth.unauthenticated'));
    }
    const actor =
      request.apiTokenActor ??
      createActorContext({
        actorId: authenticatedSession(request).userId,
        workspaceId: routeWorkspaceId,
        sessionId: authenticatedSession(request).sessionId,
        requestId: requestIdentifier(request),
        ...traceFields(traceIdentifier(request)),
      });
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId,
      capability: this.capability,
      access: this.authorization,
      disclosure: this.disclosure,
      allowedWorkspaceStatuses: this.allowedWorkspaceStatuses,
    });
    request.authorizedWorkspace = authorizedWorkspace;
    this.contexts.setWorkspace(authorizedWorkspace.workspaceId);
    return true;
  }
}

/** Bind the existing workspace authorization rule to a feature's provider. */
export function capabilityGuard(
  token: symbol,
  capability: AuthorizationCapability,
  options: Readonly<{
    disclosure?: 'forbidden' | 'not_found';
    allowedWorkspaceStatuses?: readonly WorkspaceStatus[];
  }> = {},
): Type<CanActivate> {
  class BoundCapabilityGuard extends WorkspaceCapabilityGuard {
    public constructor(
      @Inject(token) authorization: WorkspaceAuthorizationSource,
      @Inject(RequestContextStore) contexts: RequestContextStore,
    ) {
      super(capability, authorization, {
        contexts,
        disclosure: options.disclosure,
        allowedWorkspaceStatuses: options.allowedWorkspaceStatuses,
      });
    }
  }
  return mixin(BoundCapabilityGuard);
}

/** Fixed-capability guard for the current workspace lifecycle endpoints. */
export const WorkspaceManageGuard = capabilityGuard(
  WORKSPACE_AUTHORIZATION,
  'workspace:manage',
  {
    disclosure: 'forbidden',
    allowedWorkspaceStatuses: ['active', 'suspended', 'pending_deletion'],
  },
);

/** Fixed-capability guard for the workspace member read endpoint. */
export const WorkspaceMemberReadGuard = capabilityGuard(
  WORKSPACE_AUTHORIZATION,
  'member:read',
  {
    disclosure: 'forbidden',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);

/** Any active member of an active workspace, e.g. to leave it (ADR 047). */
export const WorkspaceMembershipGuard = capabilityGuard(
  WORKSPACE_AUTHORIZATION,
  'workspace:read',
  { disclosure: 'forbidden', allowedWorkspaceStatuses: ['active'] },
);

/** Any active member reading their own tokens; creating and revoking need the guard above. */
export const WorkspaceMemberBrowseGuard = capabilityGuard(
  WORKSPACE_AUTHORIZATION,
  'workspace:read',
  {
    disclosure: 'forbidden',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);

/** Pending invitations are read by those who may manage them. */
export const WorkspaceInvitationReadGuard = capabilityGuard(
  WORKSPACE_AUTHORIZATION,
  'member:manage',
  {
    disclosure: 'forbidden',
    allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
  },
);

/** Coarse route guard; persistence rechecks current roles and the transition. */
export const WorkspaceMemberManageGuard = capabilityGuard(
  WORKSPACE_AUTHORIZATION,
  'member:manage',
  { disclosure: 'forbidden', allowedWorkspaceStatuses: ['active'] },
);

function requestFrom(
  context: ExecutionContext,
): IdentityWorkspaceRequest & AuthorizationHeaderSource {
  return context
    .switchToHttp()
    .getRequest<IdentityWorkspaceRequest & AuthorizationHeaderSource>();
}

function routeWorkspace(request: IdentityWorkspaceRequest): string {
  const params = request.params;
  const invalidWorkspaceParams =
    typeof params !== 'object' || params === null || !('workspaceId' in params);
  if (invalidWorkspaceParams) {
    return throwApplicationError(applicationError('request.invalid'));
  }
  const workspaceId = params.workspaceId;
  if (!isCanonicalUuid(workspaceId))
    return throwApplicationError(applicationError('request.invalid'));
  return workspaceId;
}

export function readCookie(
  request: IdentityWorkspaceRequest,
  name: string,
): string | undefined {
  const direct = request.cookies?.[name];
  if (direct !== undefined) return direct;
  const header = firstRequestHeader(request.headers, 'cookie');
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

/**
 * When the requesting session's own user signed in (ADR 043, ADR 047). An
 * authority that cannot say answers 404; evidence for another user is a 401.
 */
export async function requireSignInEvidence(
  request: IdentityWorkspaceRequest,
  sessions: Pick<IdentitySessionAuthority, 'signInEvidence'>,
): Promise<SignInEvidence> {
  const evidence = await sessions.signInEvidence(
    readCookie(request, SESSION_COOKIE_NAME) ?? '',
  );
  if (evidence.userId !== authenticatedSession(request).userId)
    return throwApplicationError(applicationError('auth.unauthenticated'));
  return evidence;
}
