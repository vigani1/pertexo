import { z } from 'zod';
import { formatCount } from '../values/byte-size.js';

const SIGNING_KEY_MAX_BYTES = 4_096;

/** Exact UTF-8 bytes; whitespace is part of a signing key. */
export const signingKeyCredentialSchema = z
  .object({
    type: z.literal('hmac_key'),
    signingKey: z
      .string()
      .min(1)
      .max(SIGNING_KEY_MAX_BYTES)
      .refine(
        (value) => value.isWellFormed(),
        'Signing keys must be valid Unicode text',
      )
      .refine(
        (value) =>
          new TextEncoder().encode(value).byteLength <= SIGNING_KEY_MAX_BYTES,
        `Signing keys must fit ${formatCount(SIGNING_KEY_MAX_BYTES)} UTF-8 bytes`,
      ),
  })
  .strict()
  .readonly();
