import { randomUUID } from 'node:crypto';

import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { PostgresDialect } from 'kysely';
import type { Pool } from 'pg';

import type { LinkProviderGateway } from './account-linking.js';
import type { AuthenticationMail } from './authentication-mail.js';
import { isActiveUser } from './better-auth-trusted-sessions.js';
import type { OwnedEmailProofs } from './owned-email-proofs.js';
import { createTrustedSessionPlugin } from './trusted-session-plugin.js';

type PertexoBetterAuthInput = Readonly<{
  pool: Pool;
  baseUrl: string;
  secret: string;
  secureCookies: boolean;
  sessionTtlSeconds: number;
  trustedOrigins: readonly string[];
  mail: AuthenticationMail;
  emailProofs: OwnedEmailProofs;
  socialProviders?: BetterAuthOptions['socialProviders'];
  availableLinkProviders: LinkProviderGateway['available'];
}>;

/**
 * Native routes that would read or change credentials, sessions or accounts
 * outside Pertexo's transactional account-security endpoints.
 */
const DISABLED_NATIVE_PATHS = Object.freeze([
  '/get-session',
  '/get-access-token',
  '/refresh-token',
  '/list-accounts',
  '/account-info',
  '/update-session',
  '/delete-user',
  '/update-user',
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/unlink-account',
  '/set-password',
  '/change-password',
  '/reset-password',
  '/verify-email',
]);

/**
 * The policy-bearing Better Auth instance. Better Auth owns credentials and
 * browser sessions on Pertexo's own user rows in the `app` schema; Pertexo
 * keeps authorization, email proofs, linking and session revocation policy.
 */
export function createPertexoBetterAuth(input: PertexoBetterAuthInput) {
  const { pool, emailProofs } = input;
  return betterAuth({
    appName: 'Pertexo',
    baseURL: input.baseUrl,
    basePath: '/v1/auth',
    secret: input.secret,
    trustedOrigins: [...input.trustedOrigins],
    database: {
      dialect: new PostgresDialect({ pool }),
      type: 'postgres',
      casing: 'snake',
      schemaName: 'app',
      transaction: true,
    },
    user: {
      modelName: 'users',
      fields: {
        name: 'display_name',
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      deleteUser: { enabled: false },
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail }) =>
          emailProofs.issue(proofUser(user), 'change_old', newEmail),
      },
      additionalFields: {
        status: {
          type: 'string',
          input: false,
          returned: false,
          defaultValue: 'active',
        },
      },
    },
    account: accountPolicy(),
    session: sessionPolicy(input.sessionTtlSeconds),
    verification: {
      modelName: 'auth_verifications',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    emailAndPassword: credentialPolicy(pool, input.mail),
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }, request) =>
        emailProofs.issueVerification(proofUser(user), request, url),
    },
    ...(input.socialProviders === undefined
      ? {}
      : { socialProviders: input.socialProviders }),
    plugins: [createTrustedSessionPlugin(pool, input.availableLinkProviders)],
    databaseHooks: identityChangeHooks(pool),
    disabledPaths: [...DISABLED_NATIVE_PATHS],
    advanced: cookiePolicy(input.secureCookies),
    telemetry: { enabled: false },
  });
}

export type PertexoBetterAuth = ReturnType<typeof createPertexoBetterAuth>;

function proofUser(
  user: Readonly<{ id: string; email: string; name: string }>,
): Readonly<{ id: string; email: string; name: string }> {
  return { id: user.id, email: user.email, name: user.name };
}

function accountPolicy() {
  return {
    modelName: 'auth_accounts',
    fields: {
      accountId: 'account_id',
      providerId: 'provider_id',
      userId: 'user_id',
      accessToken: 'access_token',
      refreshToken: 'refresh_token',
      idToken: 'id_token',
      accessTokenExpiresAt: 'access_token_expires_at',
      refreshTokenExpiresAt: 'refresh_token_expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    accountLinking: {
      // The native callback is not bound to the initiating browser session.
      // Keep direct and already-started linking journeys closed until the
      // purpose-bound Pertexo linking protocol is delivered.
      enabled: false,
      disableImplicitLinking: true,
      allowDifferentEmails: true,
    },
    encryptOAuthTokens: true,
  } satisfies BetterAuthOptions['account'];
}

/** Server-authoritative database sessions: no cookie cache, fresh after 5 min. */
function sessionPolicy(sessionTtlSeconds: number) {
  return {
    modelName: 'auth_sessions',
    fields: {
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      ipAddress: 'ip_address',
      userAgent: 'user_agent',
      userId: 'user_id',
    },
    expiresIn: sessionTtlSeconds,
    updateAge: Math.min(60 * 60, Math.floor(sessionTtlSeconds / 4)),
    freshAge: 5 * 60,
    cookieCache: { enabled: false },
  } satisfies BetterAuthOptions['session'];
}

/** Verified-email password accounts; resets only mail existing credentials. */
function credentialPolicy(pool: Pool, mail: AuthenticationMail) {
  return {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    requireEmailVerification: true,
    autoSignIn: false,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url }) => {
      const credential = await pool.query(
        `select id from app.auth_accounts
          where user_id=$1::uuid and provider_id='credential'`,
        [user.id],
      );
      if (credential.rowCount === 0) return;
      await mail.sendPasswordReset({
        recipient: user.email,
        displayName: user.name,
        url,
      });
    },
  } satisfies BetterAuthOptions['emailAndPassword'];
}

/**
 * Identity changes end every browser session: a newly attached social account
 * and a completed email verification revoke the user's sessions, and only
 * active users may be given a new session.
 */
function identityChangeHooks(pool: Pool) {
  return {
    account: {
      create: {
        after: async (account, context) => {
          if (account.providerId !== 'credential' && context !== null)
            await context.context.internalAdapter.deleteUserSessions(
              account.userId,
            );
        },
      },
    },
    user: {
      update: {
        after: async (user, context) => {
          if (context?.path === '/verify-email')
            await pool.query('delete from app.auth_sessions where user_id=$1', [
              user.id,
            ]);
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          if (!(await isActiveUser(pool, session.userId))) return false;
          return { data: session };
        },
      },
    },
  } satisfies BetterAuthOptions['databaseHooks'];
}

function cookiePolicy(secureCookies: boolean) {
  return {
    database: { generateId: () => randomUUID() },
    cookiePrefix: 'pertexo-auth',
    useSecureCookies: secureCookies,
    defaultCookieAttributes: {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'lax',
      path: '/',
    },
    cookies: {
      session_token: { name: 'pertexo_session' },
    },
  } satisfies BetterAuthOptions['advanced'];
}
