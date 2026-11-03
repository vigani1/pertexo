import 'reflect-metadata';

import { WORKSPACE_AUTHORIZATION } from '../../src/workspaces/tokens.js';

import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
  Provider,
  Type,
} from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Role } from '@pertexo/policy';
import { vi } from 'vitest';

import { APPLICATION_ERROR_MAPPERS } from '../../src/application-errors.js';
import type { AuthorizationCapability } from '../../src/authorization/index.js';
import { DoubleSubmitCsrfPolicy } from '../../src/identity/index.js';
import {
  ProblemDetailsFilter,
  RequestContextMiddleware,
  RequestContextStore,
} from '../../src/platform/http/index.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../src/workspaces/index.js';
import type { IdentityWorkspaceRequest } from '../../src/workspaces/types.js';
import type { WorkspaceAuthorizationSource } from '../../src/workspaces/ports.js';

export const sessionActorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const sessionWorkspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const foreignWorkspaceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const sessionToken = 's'.repeat(43);
const csrfToken = 'c'.repeat(43);

/** A signed-in browser: the session cookie, plus the CSRF pair when asked. */
export function browserHeaders(
  options: Readonly<{ csrf?: boolean; idempotencyKey?: string }> = {},
): Record<string, string> {
  const csrf = options.csrf ?? true;
  return {
    cookie: csrf
      ? `pertexo_session=${sessionToken}; pertexo_csrf=${csrfToken}`
      : `pertexo_session=${sessionToken}`,
    ...(csrf ? { 'x-csrf-token': csrfToken } : {}),
    ...(options.idempotencyKey === undefined
      ? {}
      : { 'idempotency-key': options.idempotencyKey }),
  };
}

/**
 * Real Nest/Fastify routing, session admission, CSRF and workspace capability
 * guards over fake sessions, membership and stores. Records the capability
 * each request was authorized for.
 */
export async function sessionHttpApp(
  input: Readonly<{
    controller: Type;
    providers: readonly Provider[];
    /** Fields the controller keeps; Vitest drops constructor parameter types. */
    fields: Readonly<Record<string, unknown>>;
    role?: Role;
  }>,
) {
  const contexts = new RequestContextStore();
  const sessions = {
    authenticate: vi.fn((token: string) =>
      token === sessionToken
        ? Promise.resolve({
            userId: sessionActorId,
            sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            expiresAt: new Date('2099-01-01T00:00:00.000Z'),
            clientMetadata: {},
          })
        : Promise.reject(new Error('unknown session')),
    ),
  };
  const membership = {
    findAccess: vi.fn((query: Readonly<{ workspaceId: string }>) =>
      Promise.resolve(
        query.workspaceId === sessionWorkspaceId
          ? {
              actorId: sessionActorId,
              workspaceId: sessionWorkspaceId,
              role: input.role ?? 'owner',
              membershipStatus: 'active' as const,
              workspaceStatus: 'active' as const,
            }
          : undefined,
      ),
    ),
  } satisfies WorkspaceAuthorizationSource;
  const csrf = new CsrfProtectionGuard(new DoubleSubmitCsrfPolicy());
  const builder = Test.createTestingModule({
    controllers: [input.controller],
    providers: [
      { provide: RequestContextStore, useValue: contexts },
      { provide: CsrfProtectionGuard, useValue: csrf },
      // Declared routes build their capability guards on this token.
      { provide: WORKSPACE_AUTHORIZATION, useValue: membership },
      ...input.providers,
    ],
  })
    .overrideGuard(SessionAuthenticationGuard)
    .useValue(new SessionAuthenticationGuard(sessions as never, contexts))
    .overrideGuard(CsrfProtectionGuard)
    .useValue(csrf);
  const module = await builder.compile();
  Object.assign(module.get(input.controller), input.fields);
  const app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  const authorized: AuthorizationCapability[] = [];
  const middleware = new RequestContextMiddleware(contexts);
  app.use(middleware.use.bind(middleware));
  app.useGlobalInterceptors(new AuthorizedCapabilityRecorder(authorized));
  app.useGlobalFilters(
    new ProblemDetailsFilter(contexts, undefined, APPLICATION_ERROR_MAPPERS),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, csrf, membership, authorized };
}

class AuthorizedCapabilityRecorder implements NestInterceptor {
  public constructor(private readonly seen: AuthorizationCapability[]) {}

  public intercept(context: ExecutionContext, next: CallHandler) {
    const capability = context
      .switchToHttp()
      .getRequest<IdentityWorkspaceRequest>().authorizedWorkspace?.capability;
    if (capability !== undefined) this.seen.push(capability);
    return next.handle();
  }
}
