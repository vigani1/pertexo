import { z } from 'zod';
import {
  createAwsConnectionEnvelopeEncryption,
  type AwsConnectionEnvelopeEncryptionConfig,
  type AwsConnectionEnvelopeEncryptionRuntime,
} from './aws-envelope-runtime.js';
import {
  ConnectionEnvelopeEncryption,
  ConnectionSecretEncryptionError,
  connectionSecretAssociatedData,
} from './envelope-encryption.js';
import { SelfManagedEnvelopeKeyProvider } from './self-managed-key-provider.js';
import {
  decodeApplicationKey,
  parseApplicationPreviousKeys,
  validateApplicationKeyRing,
  type ApplicationKeyRing,
} from '../security/key-ring.js';

export type SelfManagedConnectionEncryptionConfig = Readonly<{
  mode: 'self-managed';
  encryption: ApplicationKeyRing;
}>;
export type ConnectionEnvelopeEncryptionConfig =
  AwsConnectionEnvelopeEncryptionConfig | SelfManagedConnectionEncryptionConfig;
export type ConnectionEnvelopeEncryptionRuntime =
  AwsConnectionEnvelopeEncryptionRuntime;

export function createConnectionEnvelopeEncryption(
  config: ConnectionEnvelopeEncryptionConfig,
): ConnectionEnvelopeEncryptionRuntime {
  if (!('mode' in config)) return createAwsConnectionEnvelopeEncryption(config);
  return Object.freeze({
    encryption: new ConnectionEnvelopeEncryption(
      new SelfManagedEnvelopeKeyProvider(
        config.encryption,
        connectionSecretAssociatedData,
        () => new ConnectionSecretEncryptionError(),
      ),
    ),
    close: (): void => {
      /* Self-managed wrapping owns no sockets or timers. */
    },
  });
}

const environmentSchema = z.object({
  CONNECTION_ENCRYPTION_MODE: z
    .enum(['local', 'kms', 'self-managed'])
    .optional(),
  CONNECTION_LOCAL_KEY: z.string().min(1).optional(),
  CONNECTION_SELF_MANAGED_KEY: z.string().min(1).optional(),
  CONNECTION_SELF_MANAGED_KEY_VERSION: z.string().min(1).optional(),
  CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: z.string().optional(),
  CONNECTION_KMS_KEY_REFERENCE: z.string().min(1).max(2_048).optional(),
  CONNECTION_KMS_REGION: z.string().min(1).max(128).optional(),
  CONNECTION_KMS_ENDPOINT: z.url().optional(),
});

export function parseConnectionEncryptionConfig(
  environment: Readonly<Record<string, string | undefined>>,
  deployed: boolean,
): ConnectionEnvelopeEncryptionConfig | undefined {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success)
    throw new Error('Connection encryption configuration is invalid');
  const config = parsed.data;
  const kmsConfigured = Object.entries(environment).some(
    ([name, value]) =>
      name.startsWith('CONNECTION_KMS_') && value !== undefined,
  );
  const selfManagedConfigured = [
    config.CONNECTION_SELF_MANAGED_KEY,
    config.CONNECTION_SELF_MANAGED_KEY_VERSION,
    config.CONNECTION_SELF_MANAGED_PREVIOUS_KEYS,
  ].some((value) => value !== undefined);
  if (config.CONNECTION_ENCRYPTION_MODE === 'local')
    return localEncryptionConfig(config, {
      deployed,
      kmsConfigured,
      selfManagedConfigured,
    });
  if (config.CONNECTION_LOCAL_KEY !== undefined)
    throw new Error('CONNECTION_LOCAL_KEY requires local encryption mode');
  if (config.CONNECTION_ENCRYPTION_MODE === 'self-managed')
    return selfManagedEncryptionConfig(config, { deployed, kmsConfigured });
  if (selfManagedConfigured)
    throw new Error('Self-managed keys require self-managed encryption mode');
  if (
    !kmsConfigured &&
    config.CONNECTION_ENCRYPTION_MODE === undefined &&
    !deployed
  )
    return undefined;
  if (
    config.CONNECTION_KMS_KEY_REFERENCE === undefined ||
    config.CONNECTION_KMS_REGION === undefined
  )
    throw new Error('Connection KMS configuration is incomplete');
  if (
    deployed &&
    config.CONNECTION_KMS_ENDPOINT !== undefined &&
    new URL(config.CONNECTION_KMS_ENDPOINT).protocol !== 'https:'
  )
    throw new Error('HTTPS connection KMS endpoint is required when deployed');
  return Object.freeze({
    keyReference: config.CONNECTION_KMS_KEY_REFERENCE,
    region: config.CONNECTION_KMS_REGION,
    ...(config.CONNECTION_KMS_ENDPOINT === undefined
      ? {}
      : { endpoint: config.CONNECTION_KMS_ENDPOINT }),
  });
}

function localEncryptionConfig(
  config: z.output<typeof environmentSchema>,
  {
    deployed,
    kmsConfigured,
    selfManagedConfigured,
  }: Readonly<{
    deployed: boolean;
    kmsConfigured: boolean;
    selfManagedConfigured: boolean;
  }>,
): SelfManagedConnectionEncryptionConfig {
  if (deployed)
    throw new Error('Local connection encryption is forbidden when deployed');
  if (kmsConfigured || selfManagedConfigured)
    throw new Error(
      'Local and other connection encryption settings cannot be mixed',
    );
  if (config.CONNECTION_LOCAL_KEY === undefined)
    throw new Error(
      'Local connection encryption requires CONNECTION_LOCAL_KEY',
    );
  return Object.freeze({
    mode: 'self-managed',
    encryption: validateApplicationKeyRing({
      current: {
        version: 'local:development',
        key: config.CONNECTION_LOCAL_KEY,
      },
    }),
  });
}

function selfManagedEncryptionConfig(
  config: z.output<typeof environmentSchema>,
  {
    deployed,
    kmsConfigured,
  }: Readonly<{
    deployed: boolean;
    kmsConfigured: boolean;
  }>,
): SelfManagedConnectionEncryptionConfig {
  if (kmsConfigured)
    throw new Error(
      'Self-managed and KMS connection encryption cannot be mixed',
    );
  if (
    config.CONNECTION_SELF_MANAGED_KEY === undefined ||
    config.CONNECTION_SELF_MANAGED_KEY_VERSION === undefined
  )
    throw new Error(
      'Self-managed connection encryption requires CONNECTION_SELF_MANAGED_KEY and CONNECTION_SELF_MANAGED_KEY_VERSION',
    );
  const encryption = validateApplicationKeyRing({
    current: {
      key: config.CONNECTION_SELF_MANAGED_KEY,
      version: config.CONNECTION_SELF_MANAGED_KEY_VERSION,
    },
    previous: parseApplicationPreviousKeys(
      config.CONNECTION_SELF_MANAGED_PREVIOUS_KEYS,
    ),
  });
  const values = new Set<string>();
  for (const entry of [encryption.current, ...encryption.previous]) {
    const bytes = decodeApplicationKey(entry.key);
    try {
      if (
        deployed &&
        bytes.equals(
          Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
        )
      )
        throw new Error(
          'Public development master keys are forbidden when deployed',
        );
      const value = bytes.toString('base64url');
      if (values.has(value))
        throw new Error(
          'Self-managed key values must be distinct for each version',
        );
      values.add(value);
    } finally {
      bytes.fill(0);
    }
  }
  return Object.freeze({ mode: 'self-managed', encryption });
}
