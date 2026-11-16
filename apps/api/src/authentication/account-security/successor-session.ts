import { isAuthenticationSessionAllowed } from '@pertexo/core/identity';
import { randomSecretToken } from '../../identity/secret-token.js';
import { generatePersistedId } from '@pertexo/database/platform';
import { setSessionCookie } from 'better-auth/cookies';
import { APIError } from 'better-auth/api';
import type { Pool } from 'pg';

type EndpointContext = Parameters<typeof setSessionCookie>[0];

/** Credential commands store the successor with its original authentication proof. */
export function prepareReplacement(
  context: EndpointContext,
  sourceSessionId: string,
) {
  return {
    id: generatePersistedId(),
    token: randomSecretToken(),
    expiresAt: new Date(
      Date.now() + context.context.sessionConfig.expiresIn * 1000,
    ),
    sourceSessionId,
    userAgent: context.context.session?.session.userAgent ?? null,
    ipAddress: context.context.session?.session.ipAddress ?? null,
  };
}
export async function replaceSessionCookie(
  context: EndpointContext,
  pool: Pool,
  token: string,
): Promise<void> {
  const found = await context.context.internalAdapter.findSession(token);
  if (
    found === null ||
    !(await isAuthenticationSessionAllowed(pool, found.session.id))
  )
    throw new APIError('UNAUTHORIZED');
  await setSessionCookie(context, found);
}
