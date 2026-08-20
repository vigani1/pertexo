import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import {
  SessionAuthenticationGuard,
  WorkspaceManageGuard,
} from '../../src/identity-workspace/index.js';
import type { IdentityWorkspaceRequest } from '../../src/identity-workspace/types.js';
import type { OpaqueSessionService } from '../../src/identity/index.js';
import {
  ProblemDetailsFilter,
  RequestContextStore,
  applicationError,
} from '../../src/platform/http/index.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const forgedWorkspaceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function executionContext(request: IdentityWorkspaceRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function authenticatedSessions(): OpaqueSessionService {
  return {
    authenticate: vi.fn().mockResolvedValue(
      Object.freeze({
        userId: actorId,
        sessionId,
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        clientMetadata: Object.freeze({}),
      }),
    ),
  } as unknown as OpaqueSessionService;
}

function request(routeWorkspaceId = workspaceId): IdentityWorkspaceRequest {
  return {
    method: 'GET',
    requestId: 'request-guard-context',
    headers: {
      cookie: 'pertexo_session=opaque-session-token',
      'x-actor-id': 'attacker-controlled',
      'x-workspace-id': forgedWorkspaceId,
    },
    params: { workspaceId: routeWorkspaceId },
  };
}

function authorizationReader() {
  return {
    findAccess: vi.fn(
      (query: Readonly<{ actorId: string; workspaceId: string }>) =>
        Promise.resolve(
          query.actorId === actorId && query.workspaceId === workspaceId
            ? {
                actorId,
                workspaceId,
                role: 'owner' as const,
                membershipStatus: 'active' as const,
                workspaceStatus: 'active' as const,
              }
            : undefined,
        ),
    ),
  };
}

describe('identity/workspace guard request correlation', () => {
  it('sets an immutable validated actor/session only after authentication', async () => {
    const contexts = new RequestContextStore();
    const guard = new SessionAuthenticationGuard(
      authenticatedSessions(),
      contexts,
    );
    const httpRequest = request();
    let beforeActor: unknown;
    let afterContext: ReturnType<RequestContextStore['get']> | undefined;

    await contexts.run('request-guard-context', async () => {
      beforeActor = contexts.get().actor;
      await expect(
        guard.canActivate(executionContext(httpRequest)),
      ).resolves.toBe(true);
      afterContext = contexts.get();
    });

    expect(beforeActor).toBeUndefined();
    expect(afterContext).toEqual({
      requestId: 'request-guard-context',
      actor: { actorId, kind: 'user', credentialId: sessionId },
    });
    expect(Object.isFrozen(afterContext)).toBe(true);
    expect(Object.isFrozen(afterContext?.actor)).toBe(true);
    expect(afterContext?.workspaceId).toBeUndefined();
    expect(() => contexts.get()).toThrow('request context is unavailable');
  });

  it('does not retain actor state when session authentication fails', async () => {
    const contexts = new RequestContextStore();
    const rejectedSessions = {
      authenticate: vi.fn().mockRejectedValue(new Error('invalid session')),
    } as unknown as OpaqueSessionService;
    const guard = new SessionAuthenticationGuard(rejectedSessions, contexts);
    const httpRequest = request();

    await contexts.run('request-rejected-session', async () => {
      await expect(
        guard.canActivate(executionContext(httpRequest)),
      ).rejects.toMatchObject({ code: 'internal.unexpected' });
      expect(contexts.get()).toEqual({
        requestId: 'request-rejected-session',
      });
      expect(httpRequest.identitySession).toBeUndefined();
    });

    contexts.run('request-after-rejection', () => {
      expect(contexts.get()).toEqual({ requestId: 'request-after-rejection' });
    });
  });

  it('adds the canonical route workspace only after authorization and correlates later failures', async () => {
    const contexts = new RequestContextStore();
    const sessions = new SessionAuthenticationGuard(
      authenticatedSessions(),
      contexts,
    );
    const reader = authorizationReader();
    const workspace = new WorkspaceManageGuard(reader, contexts);
    const logger = { log: vi.fn() };
    const filter = new ProblemDetailsFilter(contexts, logger);
    const httpRequest = request();
    const response = problemResponse();
    let actorOnlyContext: ReturnType<RequestContextStore['get']> | undefined;

    await contexts.run('request-guard-context', async () => {
      await sessions.canActivate(executionContext(httpRequest));
      actorOnlyContext = contexts.get();
      await workspace.canActivate(executionContext(httpRequest));
      filter.catch(
        applicationError('internal.unexpected'),
        problemHost(httpRequest, response),
      );
    });

    expect(actorOnlyContext?.workspaceId).toBeUndefined();
    expect(httpRequest.authorizedWorkspace).toMatchObject({ workspaceId });
    expect(reader.findAccess).toHaveBeenCalledWith({ actorId, workspaceId });
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-guard-context',
        actorId,
        workspaceId,
      }),
    );
  });

  it('denies a forged route without promoting it to workspace context or the problem log', async () => {
    const contexts = new RequestContextStore();
    const sessions = new SessionAuthenticationGuard(
      authenticatedSessions(),
      contexts,
    );
    const workspace = new WorkspaceManageGuard(authorizationReader(), contexts);
    const logger = { log: vi.fn() };
    const filter = new ProblemDetailsFilter(contexts, logger);
    const httpRequest = request(forgedWorkspaceId);
    const response = problemResponse();

    await contexts.run('request-forged-workspace', async () => {
      await sessions.canActivate(executionContext(httpRequest));
      let denied: unknown;
      try {
        await workspace.canActivate(executionContext(httpRequest));
      } catch (error: unknown) {
        denied = error;
      }
      expect(denied).toMatchObject({ code: 'auth.forbidden' });
      expect(contexts.get()).toMatchObject({
        actor: { actorId, credentialId: sessionId },
      });
      expect(contexts.get().workspaceId).toBeUndefined();
      expect(httpRequest.authorizedWorkspace).toBeUndefined();
      filter.catch(denied, problemHost(httpRequest, response));
    });

    expect(logger.log).toHaveBeenCalledWith(
      expect.not.objectContaining({ workspaceId: forgedWorkspaceId }),
    );
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'auth.forbidden',
        actorId,
        requestId: 'request-forged-workspace',
      }),
    );
  });
});

function problemResponse() {
  const response = {
    status: vi.fn(),
    header: vi.fn(),
    send: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

function problemHost(
  httpRequest: IdentityWorkspaceRequest,
  response: ReturnType<typeof problemResponse>,
): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ ...httpRequest, url: '/v1/workspaces/test' }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}
