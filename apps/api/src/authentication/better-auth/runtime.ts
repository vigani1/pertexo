import {
  needsSecurityTransaction,
  securityTransaction,
} from './transactions/response.js';
import {
  createSamlProofGateway,
  type SamlProofGateway,
} from '../federation/protocol/saml/gateway.js';
import {
  createNodeSecureHttpClient,
  type ApplicationSecretEnvelope,
} from '@pertexo/integrations/server';
import { OrganizationSignIn } from '../federation/journeys/organization.js';
import {
  createOidcProofGateway,
  type OidcProofGateway,
} from '../federation/protocol/oidc.js';
import type { BetterAuthOptions } from 'better-auth';
import {
  SignUpAvailability,
  type SignUpMode,
} from '@pertexo/core/tenant-access';
import { surviveConnectionLoss } from '@pertexo/database/platform';
import { Pool } from 'pg';
import { refuseClosedSignUp } from './sign-up-gate.js';
import { AuthenticationTransactions } from './transactions/context.js';

import { AccountLinking } from '../account-security/linking.js';
import type { SocialProviderGateway } from '../providers/contract.js';
import type { AuthenticationMail } from '../mail/delivery.js';
import {
  betterAuthSocialProviders,
  configuredSocialProviders,
} from './social-providers.js';
import { createPertexoBetterAuth, type PertexoBetterAuth } from './options.js';
import {
  authenticateBrowserRequest,
  createTrustedSessions,
  type BetterAuthTrustedSessions,
} from './trusted-sessions.js';
import { OwnedEmailProofs } from '../mail/email-proofs.js';
import { SocialSignIn } from '../federation/social.js';
import { landProviderFormCallback } from '../journeys/form-callback.js';

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
  signUpMode: SignUpMode;
  socialProviders?: BetterAuthOptions['socialProviders'];
  /** Local provider fixtures may use this seam; production uses pinned providers. */
  linkProviderGateway?: SocialProviderGateway;
  federation?: Readonly<{
    envelope: ApplicationSecretEnvelope;
    oidcGateway?: OidcProofGateway;
    samlGateway?: SamlProofGateway;
  }>;
}>;

export type BetterAuthRuntime = Readonly<{
  auth: Readonly<{
    handler(request: Request): Promise<Response>;
  }>;
  sessions: BetterAuthTrustedSessions;
  signUp: SignUpAvailability;
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
  surviveConnectionLoss(pool);
  const emailProofs = new OwnedEmailProofs(
    pool,
    config.mail,
    config.baseUrl,
    config.signUpMode,
  );
  const signUp = new SignUpAvailability(pool, config.signUpMode);
  const authOptions = {
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
      configuredSocialProviders(config.socialProviders),
  };
  const auth = createPertexoBetterAuth(authOptions);
  const transactions = new AuthenticationTransactions();
  const securityAuth = createPertexoBetterAuth({
    ...authOptions,
    transactions,
  });
  const providers =
    config.linkProviderGateway ??
    betterAuthSocialProviders(auth, config.socialProviders);
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
  const social = new SocialSignIn({
    pool,
    signUpMode: config.signUpMode,
    secret: config.secret,
    baseUrl: config.baseUrl,
    secureCookies: config.secureCookies,
    sessionTtlSeconds: config.sessionTtlSeconds,
    providers,
    deliver,
  });

  const federation = new OrganizationSignIn({
    pool,
    baseUrl: config.baseUrl,
    secret: config.secret,
    secureCookies: config.secureCookies,
    sessionTtlSeconds: config.sessionTtlSeconds,
    ...(config.federation === undefined
      ? {}
      : {
          samlGateway:
            config.federation.samlGateway ?? createSamlProofGateway(),
          gateway:
            config.federation.oidcGateway ??
            createOidcProofGateway({
              http: createNodeSecureHttpClient(),
              envelope: config.federation.envelope,
            }),
        }),
    authenticate: (request) => authenticateBrowserRequest(auth, pool, request),
    deliver,
  });
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    auth: Object.freeze({
      handler: async (request: Request): Promise<Response> => {
        const owned =
          (await landProviderFormCallback(request)) ??
          (await social.handle(request)) ??
          (await federation.handle(request)) ??
          (await linking.handle(request)) ??
          (await emailProofs.handle(request)) ??
          (await refuseClosedSignUp(request, signUp));
        if (owned !== undefined) return owned;
        const returnTo = await emailProofs.signUpReturnPath(request);
        const response = needsSecurityTransaction(request)
          ? await securityTransaction(pool, (transaction, afterCommit) =>
              transactions.run({ client: transaction, afterCommit }, () =>
                securityAuth.handler(request),
              ),
            )
          : await auth.handler(request);
        await emailProofs.issueAfterSignUp(request, response, returnTo);
        return response;
      },
    }),
    sessions,
    signUp,
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
