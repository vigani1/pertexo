import type { BetterAuthOptions } from 'better-auth';
import { Pool } from 'pg';

import { AccountLinking, type LinkProviderGateway } from './account-linking.js';
import type { AuthenticationMail } from './authentication-mail.js';
import {
  betterAuthLinkProviders,
  configuredLinkProviders,
} from './better-auth-link-providers.js';
import {
  createPertexoBetterAuth,
  type PertexoBetterAuth,
} from './better-auth-options.js';
import {
  authenticateBrowserRequest,
  createTrustedSessions,
  type BetterAuthTrustedSessions,
} from './better-auth-trusted-sessions.js';
import { OwnedEmailProofs } from './owned-email-proofs.js';

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
}>;

export type BetterAuthRuntime = Readonly<{
  auth: Readonly<{
    handler(request: Request): Promise<Response>;
  }>;
  sessions: BetterAuthTrustedSessions;
  close(): Promise<void>;
}>;

type DeliverSessionCookies = (token: string) => Promise<readonly string[]>;

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
  const emailProofs = new OwnedEmailProofs(pool, config.mail, config.baseUrl);
  const auth = createPertexoBetterAuth({
    pool,
    baseUrl: config.baseUrl,
    secret: config.secret,
    secureCookies: config.secureCookies,
    sessionTtlSeconds: config.sessionTtlSeconds,
    trustedOrigins: config.trustedOrigins,
    mail: config.mail,
    emailProofs,
    ...(config.socialProviders === undefined
      ? {}
      : { socialProviders: config.socialProviders }),
    availableLinkProviders:
      config.linkProviderGateway?.available ??
      configuredLinkProviders(config.socialProviders),
  });
  const providers =
    config.linkProviderGateway ??
    betterAuthLinkProviders(auth, config.socialProviders);
  const sessions = createTrustedSessions(auth, pool);
  const deliver: DeliverSessionCookies = async (token) =>
    (await sessions.deliver(token)).setCookies;
  const linking = new AccountLinking({
    pool,
    secret: config.secret,
    baseUrl: config.baseUrl,
    secureCookies: config.secureCookies,
    sessionTtlSeconds: config.sessionTtlSeconds,
    providers,
    authenticate: (request) => authenticateBrowserRequest(auth, pool, request),
    verifyPassword: (userId, password) =>
      verifyCredentialPassword(auth, pool, userId, password),
    deliver,
  });

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    auth: Object.freeze({
      handler: async (request: Request): Promise<Response> => {
        const owned =
          (await linking.handle(request)) ??
          (await emailProofs.handle(request));
        if (owned !== undefined) return owned;
        const returnTo = await emailProofs.signUpReturnPath(request);
        const response = await auth.handler(request);
        await emailProofs.issueAfterSignUp(request, response, returnTo);
        return response;
      },
    }),
    sessions,
    close: () => (closePromise ??= pool.end()),
  });
}

async function verifyCredentialPassword(
  auth: PertexoBetterAuth,
  pool: Pool,
  userId: string,
  password: string,
): Promise<boolean> {
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
}
