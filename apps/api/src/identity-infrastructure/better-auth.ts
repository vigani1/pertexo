import { randomUUID } from 'node:crypto';
import type { SealedAuthenticationMailPayload } from '@pertexo/database/api';

import { betterAuth, type BetterAuthOptions } from 'better-auth';
import {
  APIError,
  createAuthMiddleware,
  createAuthEndpoint,
  freshSessionMiddleware,
  getAuthoritativeSessionFromCtx,
  sensitiveSessionMiddleware,
  sessionMiddleware,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  changePasswordAndRevokeSessions,
  resetPasswordAndRevokeSessions,
  setupPasswordAndRevokeSessions,
} from './account-security-transaction.js';
import { OwnedEmailProofs } from './owned-email-proofs.js';
import { AccountLinking, type LinkProviderGateway } from './account-linking.js';
import { LegacyMethodMigration } from './legacy-method-migration.js';
import { OidcLoginService } from '../identity/oidc.js';
import type {
  OidcLoginTransactionStore,
  OidcProviderPort,
} from '../identity/ports.js';
import type { OidcConfiguration } from '../identity/types.js';

const BETTER_AUTH_COOKIE_PREFIX = 'pertexo-auth';

export type PreparedAuthenticationProofMail = Readonly<{
  id: string;
  purpose: 'verification' | 'email_change_confirmation' | 'password_reset';
  expiresAt: Date;
  sealedPayload: SealedAuthenticationMailPayload;
}>;

export type AuthenticationMail = Readonly<{
  prepareProof?(
    input: Readonly<{
      purpose: 'verification' | 'email_change_confirmation';
      recipient: string;
      displayName: string;
      url: string;
      expiresAt: Date;
      newEmail?: string;
    }>,
  ): PreparedAuthenticationProofMail;
  sendVerification(
    input: Readonly<{
      recipient: string;
      displayName: string;
      url: string;
    }>,
  ): Promise<void>;
  sendPasswordReset(
    input: Readonly<{
      recipient: string;
      displayName: string;
      url: string;
    }>,
  ): Promise<void>;
  sendEmailChangeConfirmation(
    input: Readonly<{
      recipient: string;
      displayName: string;
      newEmail: string;
      url: string;
    }>,
  ): Promise<void>;
}>;

export type BetterAuthRuntimeConfig = Readonly<{
  baseUrl: string;
  secret: string;
  database: Readonly<{
    connectionString: string;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    max: number;
  }>;
  secureCookies: boolean;
  sessionTtlSeconds: number;
  trustedOrigins: readonly string[];
  mail: AuthenticationMail;
  socialProviders?: BetterAuthOptions['socialProviders'];
  /** Local provider fixtures may use this seam; production uses pinned providers. */
  linkProviderGateway?: LinkProviderGateway;
  legacyOidc?: Readonly<{
    configuration: OidcConfiguration;
    transactions: OidcLoginTransactionStore;
    provider: OidcProviderPort;
  }>;
}>;

export type BetterAuthRuntime = Readonly<{
  auth: Readonly<{
    handler(request: Request): Promise<Response>;
  }>;
  sessions: BetterAuthTrustedSessions;
  close(): Promise<void>;
}>;

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

/**
 * Owns Better Auth's one PostgreSQL pool and the policy-bearing configuration.
 * Application authorization continues to resolve through Pertexo's user and
 * membership records; Better Auth owns credentials and browser sessions only.
 */
export function createBetterAuthRuntime(
  config: BetterAuthRuntimeConfig,
): BetterAuthRuntime {
  const pool = new Pool({
    connectionString: config.database.connectionString,
    connectionTimeoutMillis: config.database.connectionTimeoutMillis,
    idleTimeoutMillis: config.database.idleTimeoutMillis,
    max: config.database.max,
    application_name: 'pertexo-api-authentication',
  });
  const availableLinkProviders =
    config.linkProviderGateway?.available ??
    (['google', 'github', 'microsoft', 'apple'] as const).filter(
      (name) => config.socialProviders?.[name] !== undefined,
    );
  const trustedSessionPlugin = createTrustedSessionPlugin(
    pool,
    availableLinkProviders,
  );
  const emailProofs = new OwnedEmailProofs(pool, config.mail, config.baseUrl);
  const auth = betterAuth({
    appName: 'Pertexo',
    baseURL: config.baseUrl,
    basePath: '/v1/auth',
    secret: config.secret,
    trustedOrigins: [...config.trustedOrigins],
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
          emailProofs.issue(
            { id: user.id, email: user.email, name: user.name },
            'change_old',
            newEmail,
          ),
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
    account: {
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
    },
    session: {
      modelName: 'auth_sessions',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        userId: 'user_id',
      },
      expiresIn: config.sessionTtlSeconds,
      updateAge: Math.min(60 * 60, Math.floor(config.sessionTtlSeconds / 4)),
      freshAge: 5 * 60,
      cookieCache: { enabled: false },
    },
    verification: {
      modelName: 'auth_verifications',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    emailAndPassword: {
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
        await config.mail.sendPasswordReset({
          recipient: user.email,
          displayName: user.name,
          url,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user }, request) =>
        request !== undefined &&
        new URL(request.url).pathname === '/v1/auth/sign-up/email'
          ? undefined
          : emailProofs.issue(
              { id: user.id, email: user.email, name: user.name },
              'initial_verification',
            ),
    },
    ...(config.socialProviders === undefined
      ? {}
      : { socialProviders: config.socialProviders }),
    plugins: [trustedSessionPlugin],
    databaseHooks: {
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
              await pool.query(
                'delete from app.auth_sessions where user_id=$1',
                [user.id],
              );
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const result = await pool.query<{ status: string }>(
              'select status from app.users where id=$1::uuid',
              [session.userId],
            );
            if (result.rows[0]?.status !== 'active') return false;
            return { data: session };
          },
        },
      },
    },
    disabledPaths: [
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
    ],
    advanced: {
      database: { generateId: () => randomUUID() },
      cookiePrefix: BETTER_AUTH_COOKIE_PREFIX,
      useSecureCookies: config.secureCookies,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: 'lax',
        path: '/',
      },
      cookies: {
        session_token: { name: 'pertexo_session' },
      },
    },
    telemetry: { enabled: false },
  });

  const contextProvider = async (providerId: string) =>
    (await auth.$context).socialProviders.find(
      (provider) => provider.id === providerId,
    );
  const providerGateway: LinkProviderGateway = config.linkProviderGateway ?? {
    available: (['google', 'github', 'microsoft', 'apple'] as const).filter(
      (name) => config.socialProviders?.[name] !== undefined,
    ),
    authorize: async (input) => {
      const provider = await contextProvider(input.provider);
      if (provider === undefined) throw new Error('Provider unavailable');
      const url = await provider.createAuthorizationURL({
        state: input.state,
        codeVerifier: input.codeVerifier,
        idTokenNonce: input.nonce,
        redirectURI: input.redirectUri,
      });
      return url.toString();
    },
    verify: async (input) => {
      const provider = await contextProvider(input.provider);
      if (provider === undefined) return undefined;
      if (
        input.issuer !== null &&
        provider.issuer !== undefined &&
        input.issuer !== provider.issuer
      )
        return undefined;
      const tokens = await provider.validateAuthorizationCode({
        code: input.code,
        codeVerifier: input.codeVerifier,
        redirectURI: input.redirectUri,
      });
      if (tokens === null) return undefined;
      const profile = await provider.getUserInfo({
        ...tokens,
        expectedIdTokenNonce: input.nonce,
      });
      if (profile?.user === undefined) return undefined;
      const subject = await provider.accountSubject({
        tokens,
        profile: profile.data,
      });
      if (
        (typeof subject !== 'string' && typeof subject !== 'number') ||
        String(subject).trim().length === 0 ||
        (typeof subject === 'number' && !Number.isFinite(subject))
      )
        return undefined;
      return {
        accountId: String(subject),
        email: profile.user.email ?? null,
        emailVerified: profile.user.emailVerified,
      };
    },
  };
  const linking = new AccountLinking({
    pool,
    secret: config.secret,
    baseUrl: config.baseUrl,
    secureCookies: config.secureCookies,
    sessionTtlSeconds: config.sessionTtlSeconds,
    providers: providerGateway,
    authenticate: async (request) => {
      const current = await auth.api.getSession({
        headers: request.headers,
        query: { disableCookieCache: true },
      });
      if (current === null) return undefined;
      const active = await pool.query<{ status: string }>(
        'select status from app.users where id=$1::uuid',
        [current.user.id],
      );
      if (active.rows[0]?.status !== 'active') return undefined;
      return {
        userId: current.user.id,
        sessionId: current.session.id,
        emailVerified: current.user.emailVerified,
      };
    },
    verifyPassword: async (userId, password) => {
      const credential = await pool.query<{ password: string | null }>(
        `select password from app.auth_accounts
          where user_id=$1 and provider_id='credential'`,
        [userId],
      );
      const hash = credential.rows[0]?.password;
      return (
        hash !== null &&
        hash !== undefined &&
        (await auth.$context).password.verify({ hash, password })
      );
    },
    deliver: async (token) => {
      const delivery = await auth.api.deliverPertexoSession({
        body: { token },
        returnHeaders: true,
      });
      return delivery.headers.getSetCookie();
    },
  });
  const migrationOidc =
    config.legacyOidc === undefined
      ? undefined
      : new OidcLoginService(
          config.legacyOidc.configuration,
          config.legacyOidc.transactions,
          config.legacyOidc.provider,
          {
            mapExternalIdentity: async (identity) => {
              const mapped = await pool.query<{ user_id: string }>(
                `select identity.user_id from app.auth_identities identity
                 join app.users users on users.id=identity.user_id
                where identity.issuer=$1 and identity.provider_subject=$2
                  and users.status='active'`,
                [identity.issuer, identity.subject],
              );
              const userId = mapped.rows[0]?.user_id;
              return userId === undefined ? undefined : { userId };
            },
          },
        );
  const legacyMigration =
    migrationOidc === undefined
      ? undefined
      : new LegacyMethodMigration({
          pool,
          oidc: migrationOidc,
          providers: providerGateway,
          secret: config.secret,
          baseUrl: config.baseUrl,
          secureCookies: config.secureCookies,
          sessionTtlSeconds: config.sessionTtlSeconds,
          deliver: async (token) => {
            const delivery = await auth.api.deliverPertexoSession({
              body: { token },
              returnHeaders: true,
            });
            return delivery.headers.getSetCookie();
          },
        });

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    auth: Object.freeze({
      handler: async (request: Request): Promise<Response> => {
        const migrationResponse = await legacyMigration?.handle(request);
        if (migrationResponse !== undefined) return migrationResponse;
        const linkResponse = await linking.handle(request);
        if (linkResponse !== undefined) return linkResponse;
        const url = new URL(request.url);
        if (url.pathname !== '/v1/auth/verify-email') {
          const response = await auth.handler(request);
          if (
            url.pathname === '/v1/auth/sign-up/email' &&
            request.method === 'POST' &&
            response.ok
          ) {
            const parsed = z
              .object({
                user: z.object({
                  id: z.uuid(),
                  email: z.email(),
                  name: z.string(),
                }),
              })
              .safeParse(await response.clone().json());
            if (parsed.success)
              await emailProofs.issue(parsed.data.user, 'initial_verification');
          }
          return response;
        }
        const outcome =
          request.method === 'GET'
            ? await emailProofs.consume(url.searchParams.get('token') ?? '')
            : 'invalid';
        const landing = new URL('/login', config.baseUrl);
        if (outcome === 'initial_verification')
          landing.searchParams.set('verified', 'true');
        else if (outcome === 'change_old')
          landing.searchParams.set('emailChangePending', 'true');
        else if (outcome === 'change_new')
          landing.searchParams.set('emailChanged', 'true');
        else landing.searchParams.set('error', 'verification_invalid');
        return Response.redirect(landing, 302);
      },
    }),
    sessions: Object.freeze({
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
        const status = await pool.query<{ status: string }>(
          'select status from app.users where id=$1::uuid',
          [session.user.id],
        );
        signal?.throwIfAborted();
        if (status.rows[0]?.status !== 'active') return undefined;
        return Object.freeze({
          userId: session.user.id,
          sessionId: session.session.id,
          expiresAt: new Date(session.session.expiresAt),
          ...(session.session.ipAddress === null ||
          session.session.ipAddress === undefined
            ? {}
            : { ipAddress: session.session.ipAddress }),
          ...(session.session.userAgent === null ||
          session.session.userAgent === undefined
            ? {}
            : { userAgent: session.session.userAgent }),
        });
      },
      revoke: async (cookieValue: string) => {
        await auth.api.signOut({ headers: sessionHeaders(cookieValue) });
      },
      revokeToken: async (token: string) => {
        const context = await auth.$context;
        await context.internalAdapter.deleteSession(token);
      },
    }),
    close: () => (closePromise ??= pool.end()),
  });
}

function sessionHeaders(cookieValue: string): Headers {
  return new Headers({ cookie: `pertexo_session=${cookieValue}` });
}

function createTrustedSessionPlugin(
  pool: Pool,
  availableLinkProviders: LinkProviderGateway['available'],
) {
  const rejectBrowserRequest = (request: Request | undefined): void => {
    if (request !== undefined) throw new APIError('NOT_FOUND');
  };
  return {
    id: 'pertexo-trusted-session-boundary',
    endpoints: {
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
          const replacement =
            await context.context.internalAdapter.createSession(
              current.user.id,
            );
          await setSessionCookie(context, {
            session: replacement,
            user: current.user,
          });
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
          const replacement =
            await context.context.internalAdapter.createSession(
              current.user.id,
            );
          await setSessionCookie(context, {
            session: replacement,
            user: current.user,
          });
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
          const client = await pool.connect();
          try {
            await client.query('begin');
            await client.query(
              'select id from app.users where id=$1 for update',
              [current.user.id],
            );
            const accounts = await client.query<{ id: string }>(
              `select id from app.auth_accounts
                where user_id=$1
                order by id
                for update`,
              [current.user.id],
            );
            if (accounts.rows.length <= 1)
              throw new APIError('BAD_REQUEST', {
                code: 'LAST_AUTHENTICATION_METHOD',
                message: 'The last authentication method cannot be removed.',
              });
            const removed = await client.query(
              `delete from app.auth_accounts
                where id=$1 and user_id=$2
                returning id`,
              [context.body.methodId, current.user.id],
            );
            if (removed.rowCount !== 1)
              throw new APIError('NOT_FOUND', {
                code: 'AUTHENTICATION_METHOD_NOT_FOUND',
                message: 'The authentication method is not available.',
              });
            await client.query(
              'delete from app.auth_sessions where user_id=$1',
              [current.user.id],
            );
            await client.query(
              `select app.record_identity_method_audit_fact($1,'method.unlinked')`,
              [current.user.id],
            );
            await client.query('commit');
          } catch (error) {
            await client.query('rollback').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
          const replacement =
            await context.context.internalAdapter.createSession(
              current.user.id,
            );
          await setSessionCookie(context, {
            session: replacement,
            user: current.user,
          });
          return context.json({ unlinked: true });
        },
      ),
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
          const others = sessions.filter(
            (session) => session.id !== current.id,
          );
          await Promise.all(
            others.map((session) =>
              context.context.internalAdapter.deleteSession(session.token),
            ),
          );
          return context.json({ revokedCount: others.length });
        },
      ),
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
    },
    hooks: {
      before: [
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
      ],
    },
  } satisfies NonNullable<BetterAuthOptions['plugins']>[number];
}

function requireDoubleSubmitCsrf(headers: Headers | undefined): void {
  const supplied = headers?.get('x-csrf-token');
  const cookie = headers?.get('cookie');
  const expected = cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('pertexo_csrf='))
    ?.slice('pertexo_csrf='.length);
  if (
    supplied === null ||
    supplied === undefined ||
    expected === undefined ||
    supplied.length < 32 ||
    supplied !== decodeURIComponent(expected)
  )
    throw new APIError('FORBIDDEN', {
      code: 'CSRF_TOKEN_INVALID',
      message: 'The request could not be verified.',
    });
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
