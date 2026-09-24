import type { Pool } from 'pg';

import type { PertexoBetterAuth } from './better-auth-options.js';

export type BetterAuthTrustedSessions = Readonly<{
  issue(userId: string): Promise<BetterAuthSessionDelivery>;
  deliver(token: string): Promise<BetterAuthSessionDelivery>;
  authenticate(
    cookieValue: string,
    signal?: AbortSignal,
  ): Promise<BetterAuthAuthenticatedSession | undefined>;
  revoke(cookieValue: string): Promise<void>;
  revokeToken(token: string): Promise<void>;
}>;

type BetterAuthAuthenticatedSession = Readonly<{
  userId: string;
  sessionId: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
}>;

export type BetterAuthSessionDelivery = Readonly<{
  sessionId: string;
  expiresAt: Date;
  setCookies: readonly string[];
}>;

type BrowserSession = Readonly<{
  userId: string;
  sessionId: string;
  emailVerified: boolean;
}>;

/**
 * Server-side view of Better Auth's database sessions. Every lookup bypasses
 * cookie caching and re-reads the user's status, so suspension ends access on
 * the next request; issuance and delivery are server-only plugin endpoints.
 */
export function createTrustedSessions(
  auth: PertexoBetterAuth,
  pool: Pool,
): BetterAuthTrustedSessions {
  return Object.freeze({
    issue: async (userId: string) =>
      sessionDelivery(
        await auth.api.issuePertexoSession({
          body: { userId },
          returnHeaders: true,
        }),
      ),
    deliver: async (token: string) =>
      sessionDelivery(
        await auth.api.deliverPertexoSession({
          body: { token },
          returnHeaders: true,
        }),
      ),
    authenticate: async (cookieValue: string, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const session = await auth.api.getSession({
        headers: sessionHeaders(cookieValue),
        query: { disableCookieCache: true },
      });
      signal?.throwIfAborted();
      if (session === null) return undefined;
      const active = await isActiveUser(pool, session.user.id);
      signal?.throwIfAborted();
      if (!active) return undefined;
      return Object.freeze({
        userId: session.user.id,
        sessionId: session.session.id,
        expiresAt: new Date(session.session.expiresAt),
        ...optionalClientMetadata(session.session),
      });
    },
    revoke: async (cookieValue: string) => {
      await auth.api.signOut({ headers: sessionHeaders(cookieValue) });
    },
    revokeToken: async (token: string) => {
      const context = await auth.$context;
      await context.internalAdapter.deleteSession(token);
    },
  });
}

/** Resolves the browser session behind a Better Auth request for journeys. */
export async function authenticateBrowserRequest(
  auth: PertexoBetterAuth,
  pool: Pool,
  request: Request,
): Promise<BrowserSession | undefined> {
  const current = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (current === null) return undefined;
  if (!(await isActiveUser(pool, current.user.id))) return undefined;
  return {
    userId: current.user.id,
    sessionId: current.session.id,
    emailVerified: current.user.emailVerified,
  };
}

/** Only active Pertexo users may hold or create a browser session. */
export async function isActiveUser(
  pool: Pool,
  userId: string,
): Promise<boolean> {
  const result = await pool.query<{ status: string }>(
    'select status from app.users where id=$1::uuid',
    [userId],
  );
  return result.rows[0]?.status === 'active';
}

function optionalClientMetadata(
  session: Readonly<{
    ipAddress?: string | null | undefined;
    userAgent?: string | null | undefined;
  }>,
): Readonly<{ ipAddress?: string; userAgent?: string }> {
  return {
    ...(session.ipAddress === null || session.ipAddress === undefined
      ? {}
      : { ipAddress: session.ipAddress }),
    ...(session.userAgent === null || session.userAgent === undefined
      ? {}
      : { userAgent: session.userAgent }),
  };
}

function sessionHeaders(cookieValue: string): Headers {
  return new Headers({ cookie: `pertexo_session=${cookieValue}` });
}

function sessionDelivery(input: {
  headers: Headers;
  response: { sessionId: string; expiresAt: string };
}): BetterAuthSessionDelivery {
  return Object.freeze({
    sessionId: input.response.sessionId,
    expiresAt: new Date(input.response.expiresAt),
    setCookies: Object.freeze(input.headers.getSetCookie()),
  });
}
