import { readCredentialPasswordHash } from '@pertexo/core/identity';
import type { StructuredLogger } from '@pertexo/observability/server';
import { AuthenticationDiagnostics } from './diagnostics.js';
import { samlTransportAvailable } from '../federation/protocol/saml/configuration.js';
import {
  needsSecurityTransaction,
  securityTransaction,
} from './transactions/security-transaction.js';
import {
  createSamlProofGateway,
  type SamlProofGateway,
} from '../federation/protocol/saml/gateway.js';

import { createNodeProviderHttpClient } from '../../platform/connections/http-client.js';
import type { ApplicationSecretEnvelope } from '@pertexo/secrets/server';
import { OrganizationSignIn } from '../federation/journeys/organization.js';
import {
  createOidcProofGateway,
  type OidcProofGateway,
} from '../federation/protocol/oidc.js';
import type { BetterAuthOptions } from 'better-auth';
import { SignUpAvailability, type SignUpMode } from '@pertexo/core/identity';
import { surviveConnectionLoss } from '@pertexo/database/platform';
import { Pool } from 'pg';
import { refuseClosedSignUp } from './sign-up-gate.js';
import { AuthenticationTransactions } from './transactions/authentication-transactions.js';

import { AccountLinking } from '../account-security/account-linking.js';
import type { SocialProviderGateway } from '../social-provider.types.js';
import type { AuthenticationMail } from '../mail/authentication-mail.js';
import {
  betterAuthSocialProviders,
  configuredSocialProviders,
} from './social-providers.js';
import {
  createPertexoBetterAuth,
  type PertexoBetterAuth,
} from './better-auth-options.js';
import {
  authenticateBrowserRequest,
  createTrustedSessions,
  type BetterAuthTrustedSessions,
} from './trusted-sessions.js';
import { OwnedEmailProofs } from '../mail/email-proofs.js';
import { SocialSignIn } from '../federation/social-sign-in.js';
import { landProviderFormCallback } from '../journeys/form-callback.js';

export type BetterAuthRuntimeConfig = Readonly<{
  logger: StructuredLogger;
  baseUrl: string;
  secret: string;
  database: Readonly<{
    connectionString: string;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    max: number;
  }>;
  secureCookies: boolean;
  sessionSameSite?: 'lax' | 'strict' | 'none';
  sessionTtlSeconds: number;
  trustedOrigins: readonly string[];
  mail: AuthenticationMail;
  signUpMode: SignUpMode;
  socialProviders?: BetterAuthOptions['socialProviders'];
  /** Local provider fixtures may use this seam; production uses pinned providers. */
  linkProviderGateway?: SocialProviderGateway;
  federation?: Readonly<{
    database: BetterAuthRuntimeConfig['database'];
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
 * Owns Better Auth's app pool and the optional organization maintenance pool and the policy-bearing configuration.
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
  const availableOrganizationProtocols: ('oidc' | 'saml')[] = [];
  if (config.federation !== undefined) {
    availableOrganizationProtocols.push('oidc');
    if (
      samlTransportAvailable(config.baseUrl, {
        secureCookies: config.secureCookies,
      })
    )
      availableOrganizationProtocols.push('saml');
  }
  const diagnostics = new AuthenticationDiagnostics(config.logger);
  const authOptions = {
    sessionSameSite: config.sessionSameSite ?? 'lax',
    diagnostics,
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
    availableOrganizationProtocols,
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

  // Organization provisioning locks and projects several workspaces atomically.
  const organizationPool =
    config.federation === undefined
      ? pool
      : new Pool({
          ...config.federation.database,
          application_name: 'pertexo-api-organization-sign-in',
        });
  if (organizationPool !== pool) surviveConnectionLoss(organizationPool);
  const federation = new OrganizationSignIn({
    pool: organizationPool,
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
              http: createNodeProviderHttpClient(),
              envelope: config.federation.envelope,
            }),
        }),
    authenticate: (request) => authenticateBrowserRequest(auth, pool, request),
    deliver,
  });
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    auth: Object.freeze({
      handler: (request: Request): Promise<Response> =>
        diagnostics.run(request, async () => {
          const owned =
            (await landProviderFormCallback(request)) ??
            (await social.handle(request)) ??
            (await federation.handle(request)) ??
            (await linking.handle(request)) ??
            (await emailProofs.handle(request)) ??
            (await refuseClosedSignUp(request, signUp));
          if (owned !== undefined) return owned;
          const returnTo = await emailProofs.signUpReturnPath(request);
          const response = await diagnostics.response(async () =>
            needsSecurityTransaction(request)
              ? await securityTransaction(pool, (transaction, afterCommit) =>
                  transactions.run({ client: transaction, afterCommit }, () =>
                    securityAuth.handler(request),
                  ),
                )
              : await auth.handler(request),
          );
          await emailProofs.issueAfterSignUp(request, response, returnTo);
          return response;
        }),
    }),
    sessions,
    signUp,
    close: () =>
      (closePromise ??= Promise.all([
        pool.end(),
        ...(organizationPool === pool ? [] : [organizationPool.end()]),
      ]).then(() => undefined)),
  });
}

async function verifyCredentialPassword(
  auth: PertexoBetterAuth,
  pool: Pool,
  userId: string,
  password: string,
): Promise<boolean> {
  const hash = await readCredentialPasswordHash(pool, userId);
  return (
    hash !== undefined &&
    (await auth.$context).password.verify({ hash, password })
  );
}
