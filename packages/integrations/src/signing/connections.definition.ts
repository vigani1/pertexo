import { SIGNING_KEY_MAX_BYTES } from '@pertexo/node-sdk';
import { signingKeyCredentialSchema } from '@pertexo/contracts';
import { z } from 'zod';
import type { ConnectionDefinition } from '../providers/connection-definition.js';

const hmacFields = {
  signingKey: signingKeyCredentialSchema.unwrap().shape.signingKey.meta({
    title: 'Signing key',
    placeholder: 'Paste the exact signing key',
    secret: true,
    inputMaxLength: SIGNING_KEY_MAX_BYTES,
    description:
      'Whitespace is part of the key. Test checks local access only.',
  }),
};

export const HMAC_KEY_CONNECTION = {
  authType: 'hmac_key',
  presentation: {
    requirement: 'Signing key connection',
    choice: 'signing',
    pickerOrder: 5,
    name: 'Signing key',
    purpose: 'Create HMAC signatures locally',
    credential: 'HMAC key',
    savedCredential: 'HMAC key',
    usedBy: 'HMAC steps',
    nameSuffix: 'signing key',
  },
  schema: signingKeyCredentialSchema.unwrap().safeExtend(hmacFields).readonly(),
  fields: z.strictObject(hmacFields),
  auth: { kind: 'signing' },
  test: { kind: 'signing' },
  slot: { key: 'hmac_key', primary: true },
} as const satisfies ConnectionDefinition;
