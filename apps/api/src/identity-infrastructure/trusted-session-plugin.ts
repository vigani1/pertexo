import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  sensitiveSessionMiddleware,
  sessionMiddleware,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { LinkProviderGateway } from './account-linking.js';
import { accountSecurityEndpoints } from './account-security-endpoints.js';
import { requireDoubleSubmitCsrf } from './better-auth-csrf.js';

type BeforeHooks = NonNullable<
  NonNullable<BetterAuthPlugin['hooks']>['before']
>;

/**
 * Pertexo's Better Auth boundary: account-security and session-management
 * endpoints for the signed-in browser, server-only session issuance, and
 * guards on native routes whose stock behaviour bypasses Pertexo policy.
 */
export function createTrustedSessionPlugin(
  pool: Pool,
  availableLinkProviders: LinkProviderGateway['available'],
) {
  return {
    id: 'pertexo-trusted-session-boundary',
    endpoints: {
      ...accountSecurityEndpoints(pool, availableLinkProviders),
      ...sessionManagementEndpoints(),
      ...internalSessionEndpoints(),
    },
    hooks: { before: nativeRouteGuards() },
  } satisfies NonNullable<BetterAuthOptions['plugins']>[number];
}

/** Session summaries expose non-secret IDs; tokens never leave the server. */
function sessionManagementEndpoints() {
  return {
    listPertexoSessions: createAuthEndpoint(
      '/account-security/sessions',
      {
        method: 'GET',
        requireHeaders: true,
        use: [sessionMiddleware],
      },
      async (context) => {
        const current = context.context.session.session;
        const sessions = await context.context.internalAdapter.listSessions(
          context.context.session.user.id,
          { onlyActiveSessions: true },
        );
        return context.json({
          items: sessions.map((session) => ({
            id: session.id,
            current: session.id === current.id,
            createdAt: session.createdAt.toISOString(),
            updatedAt: session.updatedAt.toISOString(),
            expiresAt: session.expiresAt.toISOString(),
            ipAddress: session.ipAddress ?? null,
            userAgent: session.userAgent ?? null,
          })),
        });
      },
    ),
    revokePertexoSession: createAuthEndpoint(
      '/account-security/sessions/revoke',
      {
        method: 'POST',
        requireHeaders: true,
        use: [sensitiveSessionMiddleware],
        body: z.object({ sessionId: z.uuid() }).strict(),
      },
      async (context) => {
        requireDoubleSubmitCsrf(context.headers);
        const current = context.context.session.session;
        if (context.body.sessionId === current.id)
          throw new APIError('BAD_REQUEST', {
            code: 'CURRENT_SESSION_REQUIRES_LOGOUT',
            message: 'Sign out to end the current session.',
          });
        const sessions = await context.context.internalAdapter.listSessions(
          context.context.session.user.id,
          { onlyActiveSessions: true },
        );
        const target = sessions.find(
          (session) => session.id === context.body.sessionId,
        );
        if (target !== undefined)
          await context.context.internalAdapter.deleteSession(target.token);
        return context.json({ revoked: target !== undefined });
      },
    ),
    revokeOtherPertexoSessions: createAuthEndpoint(
      '/account-security/sessions/revoke-others',
      {
        method: 'POST',
        requireHeaders: true,
        use: [sensitiveSessionMiddleware],
        body: z.object({}).strict(),
      },
      async (context) => {
        requireDoubleSubmitCsrf(context.headers);
        const current = context.context.session.session;
        const sessions = await context.context.internalAdapter.listSessions(
          context.context.session.user.id,
          { onlyActiveSessions: true },
        );
        const others = sessions.filter((session) => session.id !== current.id);
        await Promise.all(
          others.map((session) =>
            context.context.internalAdapter.deleteSession(session.token),
          ),
        );
        return context.json({ revokedCount: others.length });
      },
    ),
  };
}

/** Reachable only through `auth.api`; any browser request is a 404. */
function internalSessionEndpoints() {
  return {
    issuePertexoSession: createAuthEndpoint(
      '/internal/session/issue',
      {
        method: 'POST',
        body: z.object({ userId: z.uuid() }).strict(),
      },
      async (context) => {
        rejectBrowserRequest(context.request);
        const user = await context.context.internalAdapter.findUserById(
          context.body.userId,
        );
        if (user === null) throw new APIError('NOT_FOUND');
        const session = await context.context.internalAdapter.createSession(
          user.id,
        );
        await setSessionCookie(context, { session, user });
        return context.json({
          sessionId: session.id,
          expiresAt: session.expiresAt.toISOString(),
        });
      },
    ),
    deliverPertexoSession: createAuthEndpoint(
      '/internal/session/deliver',
      {
        method: 'POST',
        body: z.object({ token: z.string().min(16).max(512) }).strict(),
      },
      async (context) => {
        rejectBrowserRequest(context.request);
        const found = await context.context.internalAdapter.findSession(
          context.body.token,
        );
        if (found === null) throw new APIError('NOT_FOUND');
        await setSessionCookie(context, found);
        return context.json({
          sessionId: found.session.id,
          expiresAt: found.session.expiresAt.toISOString(),
        });
      },
    ),
  };
}

/**
 * Native linking stays closed until Pertexo's purpose-bound protocol owns it,
 * and a native email change needs a session created in the last five minutes.
 */
function nativeRouteGuards(): BeforeHooks {
  return [
    {
      matcher: (context) => context.path === '/link-social',
      handler: createAuthMiddleware((context) => {
        requireDoubleSubmitCsrf(context.headers);
        throw new APIError('FORBIDDEN', {
          code: 'LINKING_NOT_READY',
          message: 'Account linking is not available.',
        });
      }),
    },
    {
      matcher: (context) => context.path === '/change-email',
      handler: createAuthMiddleware(async (context) => {
        requireDoubleSubmitCsrf(context.headers);
        const session = await getAuthoritativeSessionFromCtx(context);
        if (session === null)
          throw new APIError('UNAUTHORIZED', {
            code: 'UNAUTHORIZED',
            message: 'Authentication is required.',
          });
        if (Date.now() - session.session.createdAt.getTime() >= 5 * 60_000)
          throw new APIError('FORBIDDEN', {
            code: 'SESSION_NOT_FRESH',
            message: 'Sign in again before changing your email.',
          });
      }),
    },
  ];
}

function rejectBrowserRequest(request: Request | undefined): void {
  if (request !== undefined) throw new APIError('NOT_FOUND');
}
