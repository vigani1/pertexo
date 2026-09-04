import { z } from 'zod';

import {
  AwsKmsEnvelopeKeyProvider,
  ConnectionEnvelopeEncryption,
} from './envelope-encryption.js';
import { createBoundedKmsClient } from './kms-client.js';

const configSchema = z
  .object({
    keyReference: z.string().min(1).max(2_048),
    region: z.string().min(1).max(128),
    endpoint: z.url().optional(),
  })
  .strict();

export type AwsConnectionEnvelopeEncryptionConfig = Readonly<
  z.input<typeof configSchema>
>;

export type AwsConnectionEnvelopeEncryptionRuntime = Readonly<{
  encryption: ConnectionEnvelopeEncryption;
  close(): void;
}>;

export function createAwsConnectionEnvelopeEncryption(
  config: AwsConnectionEnvelopeEncryptionConfig,
): AwsConnectionEnvelopeEncryptionRuntime {
  const parsed = configSchema.parse(config);
  const client = createBoundedKmsClient(parsed);
  return Object.freeze({
    encryption: new ConnectionEnvelopeEncryption(
      new AwsKmsEnvelopeKeyProvider(client, parsed.keyReference),
    ),
    close: (): void => {
      client.destroy();
    },
  });
}
