import {
  APIError,
  createAuthEndpoint,
  freshSessionMiddleware,
  sensitiveSessionMiddleware,
  sessionMiddleware,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { LinkProviderGateway } from './account-linking.js';
import {
  changePasswordAndRevokeSessions,
  resetPasswordAndRevokeSessions,
  setupPasswordAndRevokeSessions,
  unlinkMethodAndRevokeSessions,
} from './account-security-transaction.js';
import { requireDoubleSubmitCsrf } from './better-auth-csrf.js';

type EndpointContext = Parameters<typeof setSessionCookie>[0];
type SessionUser = Parameters<typeof setSessionCookie>[1]['user'];

/**
 * Authentication-method management for the signed-in browser. Each credential
 * or method change revokes every session in its commit and then hands the
 * caller one replacement session.
 */
export function accountSecurityEndpoints(
  pool: Pool,
  availableLinkProviders: LinkProviderGateway['available'],
) {
  return {
    getPertexoAccountSecurity: createAuthEndpoint(
      '/account-security',
      {
        method: 'GET',
        requireHeaders: true,
        use: [sessionMiddleware],
      },
      async (context) => {
        const accounts = await context.context.internalAdapter.findAccounts(
          context.context.session.user.id,
        );
        return context.json({
          email: context.context.session.user.email,
          emailVerified: context.context.session.user.emailVerified,
          availableProviders: availableLinkProviders,
          methods: accounts.map((account) => ({
            id: account.id,
            kind: account.providerId === 'credential' ? 'password' : 'social',
            provider:
              account.providerId === 'credential' ? null : account.providerId,
          })),
        });
      },
    ),
    changePertexoPassword: createAuthEndpoint(
      '/account-security/password/change',
      {
        method: 'POST',
        requireHeaders: true,
        use: [sensitiveSessionMiddleware],
        body: z
          .object({
            currentPassword: z.string().min(1).max(128),
            newPassword: z.string().min(12).max(128),
          })
          .strict(),
      },
      async (context) => {
        requireDoubleSubmitCsrf(context.headers);
        const current = context.context.session;
        const password = await context.context.password.hash(
          context.body.newPassword,
        );
        const result = await changePasswordAndRevokeSessions(pool, {
          userId: current.user.id,
          currentPassword: context.body.currentPassword,
          newPasswordHash: password,
          verify: (hash, suppliedPassword) =>
            context.context.password.verify({
              hash,
              password: suppliedPassword,
            }),
        });
        if (result === 'inactive') throw new APIError('UNAUTHORIZED');
        if (result === 'invalid')
          throw new APIError('BAD_REQUEST', {
            code: 'INVALID_PASSWORD',
            message: 'The current password is incorrect.',
          });
        await replaceSessionCookie(context, current.user);
        return context.json({ changed: true });
      },
    ),
    setPertexoPassword: createAuthEndpoint(
      '/account-security/password/setup',
      {
        method: 'POST',
        requireHeaders: true,
        use: [freshSessionMiddleware],
        body: z.object({ newPassword: z.string().min(12).max(128) }).strict(),
      },
      async (context) => {
        requireDoubleSubmitCsrf(context.headers);
        const current = context.context.session;
        const password = await context.context.password.hash(
          context.body.newPassword,
        );
        const result = await setupPasswordAndRevokeSessions(pool, {
          userId: current.user.id,
          passwordHash: password,
        });
        if (result === 'inactive') throw new APIError('UNAUTHORIZED');
        if (result === 'unverified')
          throw new APIError('FORBIDDEN', {
            code: 'EMAIL_VERIFICATION_REQUIRED',
            message: 'Verify your email before adding a password.',
          });
        if (result === 'already')
          throw new APIError('CONFLICT', {
            code: 'PASSWORD_ALREADY_CONFIGURED',
            message: 'A password is already configured.',
          });
        await replaceSessionCookie(context, current.user);
        return context.json({ configured: true });
      },
    ),
    resetPertexoPassword: createAuthEndpoint(
      '/account-security/password/reset',
      {
        method: 'POST',
        body: z
          .object({
            token: z.string().min(1).max(512),
            newPassword: z.string().min(12).max(128),
          })
          .strict(),
      },
      async (context) => {
        const passwordHash = await context.context.password.hash(
          context.body.newPassword,
        );
        const result = await resetPasswordAndRevokeSessions(pool, {
          token: context.body.token,
          passwordHash,
        });
        if (result === 'invalid')
          throw new APIError('BAD_REQUEST', {
            code: 'INVALID_TOKEN',
            message: 'The reset link is invalid or expired.',
          });
        return context.json({ status: true });
      },
    ),
    unlinkPertexoAccount: createAuthEndpoint(
      '/account-security/methods/unlink',
      {
        method: 'POST',
        requireHeaders: true,
        use: [freshSessionMiddleware],
        body: z.object({ methodId: z.uuid() }).strict(),
      },
      async (context) => {
        requireDoubleSubmitCsrf(context.headers);
        const current = context.context.session;
        const result = await unlinkMethodAndRevokeSessions(pool, {
          userId: current.user.id,
          methodId: context.body.methodId,
        });
        if (result === 'last_method')
          throw new APIError('BAD_REQUEST', {
            code: 'LAST_AUTHENTICATION_METHOD',
            message: 'The last authentication method cannot be removed.',
          });
        if (result === 'not_found')
          throw new APIError('NOT_FOUND', {
            code: 'AUTHENTICATION_METHOD_NOT_FOUND',
            message: 'The authentication method is not available.',
          });
        await replaceSessionCookie(context, current.user);
        return context.json({ unlinked: true });
      },
    ),
  };
}

/** The committed change revoked every session; issue the caller's successor. */
async function replaceSessionCookie(
  context: EndpointContext,
  user: SessionUser,
): Promise<void> {
  const replacement = await context.context.internalAdapter.createSession(
    user.id,
  );
  await setSessionCookie(context, { session: replacement, user });
}
