import { z } from 'zod';
import {
  MAX_KEY_REFERENCE_BYTES,
  MAX_KMS_REGION_LENGTH,
} from './envelopes/envelope-format.js';

import {
  AwsKmsEnvelopeKeyProvider,
  ConnectionEnvelopeEncryption,
} from './envelopes/envelope-encryption.js';
import { createBoundedKmsClient } from './keys/kms-client.js';
import { isValidEnvelopeKeyReference } from './envelopes/envelope-cipher.js';

const configSchema = z
  .object({
    keyReference: z
      .string()
      .min(1)
      .max(MAX_KEY_REFERENCE_BYTES)
      .refine(isValidEnvelopeKeyReference),
    region: z.string().min(1).max(MAX_KMS_REGION_LENGTH),
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
