import { z } from 'zod';
import {
  createAwsConnectionEnvelopeEncryption,
  type AwsConnectionEnvelopeEncryptionConfig,
  type AwsConnectionEnvelopeEncryptionRuntime,
} from './aws-envelope-runtime.js';
import { ConnectionEnvelopeEncryption } from './envelope-encryption.js';
import { LocalEnvelopeKeyProvider } from './local-key-provider.js';

export type LocalConnectionEncryptionConfig = Readonly<{
  mode: 'local';
  key: string;
}>;
export type ConnectionEnvelopeEncryptionConfig =
  AwsConnectionEnvelopeEncryptionConfig | LocalConnectionEncryptionConfig;
export type ConnectionEnvelopeEncryptionRuntime =
  AwsConnectionEnvelopeEncryptionRuntime;

export function createConnectionEnvelopeEncryption(
  config: ConnectionEnvelopeEncryptionConfig,
): ConnectionEnvelopeEncryptionRuntime {
  if (!('mode' in config)) return createAwsConnectionEnvelopeEncryption(config);
  return Object.freeze({
    encryption: new ConnectionEnvelopeEncryption(
      new LocalEnvelopeKeyProvider(config.key),
    ),
    close: (): void => {
      // Local wrapping owns no client sockets or timers.
    },
  });
}

const environmentSchema = z.object({
  CONNECTION_ENCRYPTION_MODE: z.enum(['local', 'kms']).optional(),
  CONNECTION_LOCAL_KEY: z.string().min(1).optional(),
  CONNECTION_KMS_KEY_REFERENCE: z.string().min(1).max(2_048).optional(),
  CONNECTION_KMS_REGION: z.string().min(1).max(128).optional(),
  CONNECTION_KMS_ENDPOINT: z.url().optional(),
});

export function parseConnectionEncryptionConfig(
  environment: Readonly<Record<string, string | undefined>>,
  deployed: boolean,
): ConnectionEnvelopeEncryptionConfig | undefined {
  const config = environmentSchema.parse(environment);
  const kmsConfigured = Object.entries(environment).some(
    ([name, value]) =>
      name.startsWith('CONNECTION_KMS_') && value !== undefined,
  );
  if (config.CONNECTION_ENCRYPTION_MODE === 'local') {
    if (deployed)
      throw new Error('Local connection encryption is forbidden when deployed');
    if (kmsConfigured)
      throw new Error('Local and KMS connection encryption cannot be mixed');
    if (config.CONNECTION_LOCAL_KEY === undefined)
      throw new Error(
        'Local connection encryption requires CONNECTION_LOCAL_KEY',
      );
    // Validate the master key once, before either process starts accepting work.
    new LocalEnvelopeKeyProvider(config.CONNECTION_LOCAL_KEY);
    return Object.freeze({ mode: 'local', key: config.CONNECTION_LOCAL_KEY });
  }
  if (config.CONNECTION_LOCAL_KEY !== undefined)
    throw new Error('CONNECTION_LOCAL_KEY requires local encryption mode');
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
