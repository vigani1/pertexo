import { randomUUID } from 'node:crypto';

import { APIError } from 'better-auth/api';
import {
  authorizeCredentialSignIn,
  hasCredentialAccount,
} from '@pertexo/core/tenant-access';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import type { AuthenticationTransactions } from './transactions/context.js';
import { AuthenticationTransactionDialect } from './transactions/dialect.js';

import type { SocialProviderGateway } from '../providers/contract.js';
import type { AuthenticationMail } from '../mail/delivery.js';
import type { OwnedEmailProofs } from '../mail/email-proofs.js';
import { createTrustedSessionPlugin } from './session-plugin.js';
import {
  createTwoFactorPlugin,
  isTwoFactorVerificationPath,
  authenticationChangedError,
} from './two-factor.js';

type PertexoBetterAuthInput = Readonly<{
  pool: Pool;
  transactions?: AuthenticationTransactions;
  baseUrl: string;
  secret: string;
  secureCookies: boolean;
  sessionTtlSeconds: number;
  trustedOrigins: readonly string[];
  mail: AuthenticationMail;
  emailProofs: OwnedEmailProofs;
  socialProviders?: BetterAuthOptions['socialProviders'];
  availableLinkProviders: SocialProviderGateway['available'];
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
  '/two-factor/send-otp',
  '/two-factor/verify-otp',
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
    // Security mutations borrow the caller's transaction: the SDK must neither
    // release its client nor open a nested transaction before the notice commits.
    database: {
      dialect:
        input.transactions === undefined
          ? new PostgresDialect({ pool })
          : new AuthenticationTransactionDialect(pool, input.transactions),
      type: 'postgres',
      casing: 'snake',
      schemaName: 'app',
      transaction: input.transactions === undefined,
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
    plugins: [
      createTwoFactorPlugin(),
      createTrustedSessionPlugin(pool, input.availableLinkProviders, {
        mail: input.mail,
        transactions: input.transactions,
        accountUrl: new URL('/account/security', input.baseUrl).toString(),
      }),
    ],
    databaseHooks: identityChangeHooks(pool, input.transactions),
    disabledPaths: [...DISABLED_NATIVE_PATHS],
    advanced: cookiePolicy({ secureCookies: input.secureCookies }),
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
      // Purpose-bound sign-in/linking own the atomic identity handoff.
      // Native account attachment cannot share that transaction.
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
      if (!(await hasCredentialAccount(pool, user.id))) return;
      await mail.sendPasswordReset({
        recipient: user.email,
        displayName: user.name,
        url,
      });
    },
  } satisfies BetterAuthOptions['emailAndPassword'];
}

/**
 * Only active users may be given a native credential session.
 * Provider sign-in and linking revoke sessions in their identity transaction.
 */
function identityChangeHooks(
  pool: Pool,
  transactions?: AuthenticationTransactions,
) {
  return {
    session: {
      create: {
        before: async (session, context) => {
          const decision = await authorizeCredentialSignIn(
            pool,
            session.userId,
            transactions?.current()?.client,
          );
          if (
            isTwoFactorVerificationPath(context?.path) &&
            (decision === 'inactive' || decision === 'sso_required')
          )
            throw authenticationChangedError();
          if (decision === 'inactive') throw new APIError('UNAUTHORIZED');
          if (decision === 'sso_required')
            throw new APIError('FORBIDDEN', {
              code: 'SSO_REQUIRED',
              message: 'Use your organization sign-in to continue.',
            });
          return { data: session };
        },
      },
    },
  } satisfies BetterAuthOptions['databaseHooks'];
}

function cookiePolicy({ secureCookies }: Readonly<{ secureCookies: boolean }>) {
  return {
    database: { generateId: () => randomUUID() },
    cookiePrefix: 'pertexo-auth',
    // A `__Secure-` name prefix would rename `pertexo_session`, which the
    // guards, the CSRF bridge and session lookup read by name; HTTPS
    // deployments still get the Secure attribute below.
    useSecureCookies: false,
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
