import {
  createOidcLoginTransactionStore,
  type DatabaseConfig,
  type DatabaseRuntime,
  type OidcLoginTransactionStore as DatabaseOidcLoginTransactionStore,
} from '@pertexo/database/api';

import {
  GenericOidcProviderAdapter,
  createOidcSecretEncryptionAdapter,
} from '../../identity-infrastructure/index.js';
import type { OidcLoginTransactionStore } from '../../identity/index.js';
import type { ApiIdentityConfig } from '../config/identity-config.js';

type OidcConfig = NonNullable<ApiIdentityConfig['oidc']>;

export type OidcTransactionOverrides = Readonly<{
  transactions?: DatabaseOidcLoginTransactionStore;
  transactionFactory?: typeof createOidcLoginTransactionStore;
}>;

/** The generic OIDC provider adapter for one registered redirect URI. */
export function genericOidcProvider(
  oidc: OidcConfig,
  redirectUri: string,
): GenericOidcProviderAdapter {
  return new GenericOidcProviderAdapter({
    issuer: oidc.issuer,
    authorizationEndpoint: oidc.authorizationEndpoint,
    tokenEndpoint: oidc.tokenEndpoint,
    jwksUri: oidc.jwksUri,
    redirectUri,
    clientId: oidc.clientId,
    ...(oidc.clientSecret === undefined
      ? {}
      : { clientSecret: oidc.clientSecret }),
    allowedAlgorithms: [...oidc.allowedAlgorithms],
    timeoutMillis: oidc.timeoutMillis,
    allowInsecureHttpForTests: oidc.allowInsecureHttpForTests,
  });
}

/**
 * Opens the encrypted OIDC transaction store when legacy OIDC is configured.
 * An injected store without OIDC configuration is a composition error.
 */
export function openOidcTransactionStore(
  config: ApiIdentityConfig,
  databaseConfig: DatabaseConfig,
  overrides: OidcTransactionOverrides,
  runtime?: DatabaseRuntime,
): DatabaseOidcLoginTransactionStore | undefined {
  if (config.oidc !== undefined && config.secretEncryption !== undefined) {
    const encryption = createOidcSecretEncryptionAdapter(
      config.secretEncryption,
    );
    return (
      overrides.transactions ??
      (overrides.transactionFactory ?? createOidcLoginTransactionStore)(
        databaseConfig,
        encryption,
        runtime,
      )
    );
  }
  if (overrides.transactions !== undefined)
    throw new TypeError(
      'An OIDC transaction store requires OIDC configuration',
    );
  return undefined;
}

/** Narrows database consumption results to the application's closed union. */
export function adaptTransactionStore(
  database: DatabaseOidcLoginTransactionStore,
): OidcLoginTransactionStore {
  return Object.freeze<OidcLoginTransactionStore>({
    create: (transaction) => database.create(transaction),
    consume: async (stateDigest, browserBindingDigest, now) => {
      const result = await database.consume(
        stateDigest,
        browserBindingDigest,
        now,
      );
      switch (result.status) {
        case 'ok': {
          const transaction = (
            result as Readonly<{
              transaction?: typeof result.transaction;
            }>
          ).transaction;
          if (transaction === undefined)
            throw new Error('OIDC transaction result is missing its value');
          return Object.freeze({
            status: 'ok' as const,
            transaction,
          });
        }
        case 'missing':
        case 'expired':
        case 'replayed':
        case 'binding_mismatch':
          return Object.freeze({ status: result.status });
      }
    },
  });
}
