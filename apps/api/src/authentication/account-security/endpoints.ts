import { randomUUID, randomBytes } from 'node:crypto';
import {
  isAuthenticationSessionAllowed,
  changePasswordAndRevokeSessions,
  resetPasswordAndRevokeSessions,
  setupPasswordAndRevokeSessions,
  unlinkMethodAndRevokeSessions,
} from '@pertexo/core/tenant-access';
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

import type { SocialProviderGateway } from '../providers/contract.js';
import { requireDoubleSubmitCsrf } from '../better-auth/csrf.js';

type EndpointContext = Parameters<typeof setSessionCookie>[0];

/**
 * Authentication-method management for the signed-in browser. Each credential
 * or method change revokes every session in its commit and then hands the
 * caller one replacement session.
 */
export function accountSecurityEndpoints(
  pool: Pool,
  availableLinkProviders: SocialProviderGateway['available'],
) {
  return {
    getPertexoAccountSecurity: createGetPertexoAccountSecurityEndpoint(
      pool,
      availableLinkProviders,
    ),
    changePertexoPassword: createChangePertexoPasswordEndpoint(pool),
    setPertexoPassword: createSetPertexoPasswordEndpoint(pool),
    resetPertexoPassword: createResetPertexoPasswordEndpoint(pool),
    unlinkPertexoAccount: createUnlinkPertexoAccountEndpoint(pool),
  };
}

function createGetPertexoAccountSecurityEndpoint(
  pool: Pool,
  availableLinkProviders: SocialProviderGateway['available'],
) {
  return createAuthEndpoint(
    '/account-security',
    {
      method: 'GET',
      requireHeaders: true,
      use: [sessionMiddleware],
    },
    async (context) => {
      const enabled = context.context.session.user.twoFactorEnabled === true;
      let recoveryCodesRemaining: number | null = null;
      if (enabled) {
        const plugin = context.context.getPlugin('two-factor');
        if (plugin === null)
          throw new Error('Two-factor plugin is not configured');
        recoveryCodesRemaining = (
          await plugin.endpoints.viewBackupCodes({
            body: { userId: context.context.session.user.id },
            context: context.context,
          })
        ).backupCodes.length;
      }
      const accounts = await context.context.internalAdapter.findAccounts(
        context.context.session.user.id,
      );
      const providers = await pool.query<{ id: string; name: string }>(
        'select id,name from app.auth_providers where id::text=any($1::text[])',
        [accounts.map((account) => account.providerId)],
      );
      const names = new Map(
        providers.rows.map((provider) => [provider.id, provider.name]),
      );
      return context.json({
        email: context.context.session.user.email,
        emailVerified: context.context.session.user.emailVerified,
        availableProviders: availableLinkProviders,
        twoFactor: { enabled, recoveryCodesRemaining },
        methods: accounts.map((account) => ({
          id: account.id,
          kind: accountMethodKind(account.providerId, names),
          ...(names.has(account.providerId)
            ? { label: names.get(account.providerId) }
            : {}),
          provider:
            account.providerId === 'credential' ? null : account.providerId,
        })),
      });
    },
  );
}

function createChangePertexoPasswordEndpoint(pool: Pool) {
  return createAuthEndpoint(
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
      const replacement = prepareReplacement(context, current.session.id);
      const password = await context.context.password.hash(
        context.body.newPassword,
      );
      const result = await changePasswordAndRevokeSessions(pool, {
        userId: current.user.id,
        currentPassword: context.body.currentPassword,
        replacement,
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
      await replaceSessionCookie(context, pool, replacement.token);
      return context.json({ changed: true });
    },
  );
}

function createSetPertexoPasswordEndpoint(pool: Pool) {
  return createAuthEndpoint(
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
      const replacement = prepareReplacement(context, current.session.id);
      const password = await context.context.password.hash(
        context.body.newPassword,
      );
      const result = await setupPasswordAndRevokeSessions(pool, {
        userId: current.user.id,
        passwordHash: password,
        replacement,
      });
      if (result === 'inactive') throw new APIError('UNAUTHORIZED');
      if (result === 'unverified')
        throw new APIError('FORBIDDEN', {
          code: 'EMAIL_VERIFICATION_REQUIRED',
          message: 'Verify your email before adding a password.',
        });
      if (result === 'limit')
        throw new APIError('BAD_REQUEST', {
          code: 'AUTHENTICATION_METHOD_LIMIT',
          message: 'Remove an unused sign-in method before adding another.',
        });
      if (result === 'already')
        throw new APIError('CONFLICT', {
          code: 'PASSWORD_ALREADY_CONFIGURED',
          message: 'A password is already configured.',
        });
      await replaceSessionCookie(context, pool, replacement.token);
      return context.json({ configured: true });
    },
  );
}

function createResetPertexoPasswordEndpoint(pool: Pool) {
  return createAuthEndpoint(
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
  );
}

function createUnlinkPertexoAccountEndpoint(pool: Pool) {
  return createAuthEndpoint(
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
      const replacement = prepareReplacement(context, current.session.id);
      const result = await unlinkMethodAndRevokeSessions(pool, {
        userId: current.user.id,
        methodId: context.body.methodId,
        replacement,
      });
      if (result === 'inactive') throw new APIError('UNAUTHORIZED');
      if (result === 'protected_recovery')
        throw new APIError('FORBIDDEN', {
          code: 'RECOVERY_PASSWORD_REQUIRED',
          message:
            'Keep the recovery owner password while organization SSO is required.',
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
      await replaceSessionCookie(context, pool, replacement.token);
      return context.json({ unlinked: true });
    },
  );
}

/** Credential commands store the successor with its original authentication proof. */
function prepareReplacement(context: EndpointContext, sourceSessionId: string) {
  return {
    id: randomUUID(),
    token: randomBytes(32).toString('base64url'),
    expiresAt: new Date(
      Date.now() + context.context.sessionConfig.expiresIn * 1000,
    ),
    sourceSessionId,
    userAgent: context.context.session?.session.userAgent ?? null,
    ipAddress: context.context.session?.session.ipAddress ?? null,
  };
}
async function replaceSessionCookie(
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

function accountMethodKind(
  providerId: string,
  names: ReadonlyMap<string, string>,
): 'password' | 'organization' | 'social' {
  if (providerId === 'credential') return 'password';
  return names.has(providerId) ? 'organization' : 'social';
}
