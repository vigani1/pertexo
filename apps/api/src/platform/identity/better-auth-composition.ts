import { Pool } from 'pg';
import {
  createAuthenticationMailEnqueueStore,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/api';
import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';

import {
  DurableAuthenticationMail,
  LocalAuthenticationMailSink,
  createBetterAuthRuntime,
  disabledAuthenticationMail,
  type AuthenticationMail,
  type BetterAuthRuntime,
} from '../../identity-infrastructure/index.js';
import type {
  OidcLoginTransactionStore,
  OidcProviderPort,
} from '../../identity/index.js';
import type { ApiIdentityConfig } from '../config/identity-config.js';
import { genericOidcProvider } from './oidc-runtime.js';

type BetterAuthConfig = NonNullable<ApiIdentityConfig['betterAuth']>;

/** Registers a resource with the owner that closes it on failure or shutdown. */
export type AcquireResource = <Resource extends Readonly<{ close(): unknown }>>(
  resource: Resource,
) => Resource;

const LEGACY_MIGRATION_CALLBACK_PATH =
  '/v1/auth/legacy-migration/oidc/callback';

/**
 * Standalone Better Auth replaces legacy OIDC sign-in, so it cannot start
 * while any active user can still sign in only through the legacy issuer.
 */
export async function assertStandaloneCutoverReady(
  legacyOnlyUserCount: () => Promise<number>,
): Promise<void> {
  const legacyOnlyUsers = await legacyOnlyUserCount();
  if (legacyOnlyUsers > 0)
    throw new Error(
      `Standalone Better Auth cutover blocked: ${String(legacyOnlyUsers)} active legacy-only user(s) require an approved recovery mapping`,
    );
}

/** Counts active users with a legacy identity and no Better Auth method. */
export async function countLegacyOnlyUsers(
  config: DatabaseConfig,
): Promise<number> {
  const pool = new Pool({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    max: 1,
  });
  try {
    const result = await pool.query<{ affected: number }>(
      `select count(*)::integer affected
         from app.users users
        where users.status='active'
          and exists (
            select 1 from app.auth_identities identity
             where identity.user_id=users.id
          )
          and not exists (
            select 1 from app.auth_accounts account
             where account.user_id=users.id
          )`,
    );
    return result.rows[0]?.affected ?? 0;
  } finally {
    await pool.end();
  }
}

/**
 * Composes the Better Auth runtime for the public web origin. With legacy
 * OIDC configured, the old issuer is wired only as migration proof on its
 * own callback path.
 */
export function composeBetterAuthRuntime(
  input: Readonly<{
    config: ApiIdentityConfig;
    betterAuth: BetterAuthConfig;
    databaseConfig: DatabaseConfig;
    runtime: DatabaseRuntime | undefined;
    transactions: OidcLoginTransactionStore | undefined;
    provider: OidcProviderPort | undefined;
    authenticationMail: AuthenticationMail | undefined;
    acquire: AcquireResource;
  }>,
): BetterAuthRuntime {
  const { config } = input;
  const publicOrigin = identityPublicOrigin(config);
  const mail = selectAuthenticationMail(input);
  return input.acquire(
    createBetterAuthRuntime({
      baseUrl: publicOrigin,
      secret: input.betterAuth.secret,
      database: input.databaseConfig,
      secureCookies: config.session.secureCookie,
      sessionTtlSeconds: Math.floor(config.session.ttlMillis / 1_000),
      trustedOrigins: [publicOrigin],
      mail,
      socialProviders: input.betterAuth.providers,
      ...(config.oidc === undefined || input.transactions === undefined
        ? {}
        : {
            legacyOidc: legacyMigrationOidc(
              config.oidc,
              input.transactions,
              publicOrigin,
              input.provider,
            ),
          }),
    }),
  );
}

/** An injected mailer wins; otherwise the configured mode selects delivery. */
function selectAuthenticationMail(
  input: Readonly<{
    betterAuth: BetterAuthConfig;
    databaseConfig: DatabaseConfig;
    runtime: DatabaseRuntime | undefined;
    authenticationMail: AuthenticationMail | undefined;
    acquire: AcquireResource;
  }>,
): AuthenticationMail {
  if (input.authenticationMail !== undefined) return input.authenticationMail;
  if (input.betterAuth.mailMode === 'local')
    return new LocalAuthenticationMailSink();
  if (input.betterAuth.mailMode !== 'durable')
    return disabledAuthenticationMail;
  const durable = input.betterAuth.durableMail;
  if (durable === undefined)
    throw new TypeError('Durable authentication mail is not configured');
  return new DurableAuthenticationMail(
    input.acquire(
      createAuthenticationMailEnqueueStore(input.databaseConfig, input.runtime),
    ),
    createApplicationSecretEnvelope(durable.encryption),
    durable.fromEmail,
  );
}

function legacyMigrationOidc(
  oidc: NonNullable<ApiIdentityConfig['oidc']>,
  transactions: OidcLoginTransactionStore,
  publicOrigin: string,
  provider: OidcProviderPort | undefined,
) {
  const redirectUri = new URL(
    LEGACY_MIGRATION_CALLBACK_PATH,
    publicOrigin,
  ).toString();
  return {
    configuration: {
      issuer: oidc.issuer,
      authorizationEndpoint: oidc.authorizationEndpoint,
      clientId: oidc.clientId,
      redirectUri,
      scopes: oidc.scopes,
      transactionTtlMillis: oidc.transactionTtlMillis,
    },
    transactions,
    provider: provider ?? genericOidcProvider(oidc, redirectUri),
  };
}

function identityPublicOrigin(config: ApiIdentityConfig): string {
  if (config.publicWebOrigin !== undefined) return config.publicWebOrigin;
  if (config.oidc !== undefined) return new URL(config.oidc.redirectUri).origin;
  throw new TypeError('Identity public web origin is not configured');
}
