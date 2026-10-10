import { createAuthenticationMailEnqueueStore } from '@pertexo/database/tenant-access';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';

import {
  DurableAuthenticationMail,
  LocalAuthenticationMailSink,
  createBetterAuthRuntime,
  printLocalAuthenticationMail,
  type AuthenticationMail,
  type BetterAuthRuntime,
} from '../../authentication/index.js';
import type { ApiIdentityConfig } from '../config/identity.js';

type BetterAuthConfig = ApiIdentityConfig['betterAuth'];

/** Registers a resource with the owner that closes it on failure or shutdown. */
export type AcquireResource = <Resource extends Readonly<{ close(): unknown }>>(
  resource: Resource,
) => Resource;

/** Composes the Better Auth runtime for the public web origin. */
export function composeBetterAuthRuntime(
  input: Readonly<{
    config: ApiIdentityConfig;
    databaseConfig: DatabaseConfig;
    runtime: DatabaseRuntime | undefined;
    authenticationMail: AuthenticationMail | undefined;
    acquire: AcquireResource;
  }>,
): BetterAuthRuntime {
  const { config } = input;
  const publicOrigin = config.publicWebOrigin;
  const mail = selectAuthenticationMail({
    ...input,
    betterAuth: config.betterAuth,
  });
  return input.acquire(
    createBetterAuthRuntime({
      baseUrl: publicOrigin,
      secret: config.betterAuth.secret,
      database: input.databaseConfig,
      secureCookies: config.session.secureCookie,
      sessionTtlSeconds: Math.floor(config.session.ttlMillis / 1_000),
      trustedOrigins: [publicOrigin],
      mail,
      socialProviders: config.betterAuth.providers,
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
    return new LocalAuthenticationMailSink(
      input.betterAuth.printLocalMailLinks === true
        ? printLocalAuthenticationMail
        : undefined,
    );
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
