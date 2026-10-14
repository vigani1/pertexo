import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { createAutomationActorContext } from '../../authorization/index.js';
import {
  applicationError,
  throwApplicationError,
  RequestContextStore,
} from '../../platform/http/index.js';
import { setResponseHeader } from '../../platform/http/request-context.js';
import type { HttpResponseLike } from '../../platform/http/request-context.js';
import {
  SessionAuthenticationGuard,
  SESSION_COOKIE_NAME,
  readCookie,
} from '../../workspaces/http/guards.js';
import {
  requestIdentifier,
  traceIdentifier,
} from '../../workspaces/request/identifiers.js';
import type { IdentityWorkspaceRequest } from '../../workspaces/types.js';
import { hasAuthorizationHeader } from './headers.js';
import { ApiTokenAuthentication } from './authority.js';

@Injectable()
export class AutomationAuthenticationGuard implements CanActivate {
  public constructor(
    private readonly sessions: SessionAuthenticationGuard,
    private readonly authentication: ApiTokenAuthentication,
    private readonly contexts: RequestContextStore,
  ) {}
  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<IdentityWorkspaceRequest>();
    if (!hasAuthorizationHeader(request.headers))
      return this.sessions.canActivate(context);
    const verified = await this.authentication.authenticate({
      headers: request.headers,
      clientAddress: request.ip ?? 'unknown-client',
      hasSession: readCookie(request, SESSION_COOKIE_NAME) !== undefined,
    });
    if (verified === undefined) return this.unauthenticated(context);
    const traceId = traceIdentifier(request);
    const actor = createAutomationActorContext({
      actorId: verified.ownerUserId,
      workspaceId: verified.workspaceId,
      tokenId: verified.tokenId,
      scopes: verified.scopes,
      requestId: requestIdentifier(request),
      ...(traceId === undefined ? {} : { traceId }),
    });
    request.apiTokenActor = actor;
    this.contexts.setActor({
      actorId: actor.actorId,
      kind: actor.kind,
      credentialId: actor.tokenId,
    });
    return true;
  }
  private unauthenticated(context: ExecutionContext): never {
    setResponseHeader(
      context.switchToHttp().getResponse<HttpResponseLike>(),
      'WWW-Authenticate',
      'Bearer realm="pertexo", error="invalid_token"',
    );
    return throwApplicationError(applicationError('auth.unauthenticated'));
  }
}
