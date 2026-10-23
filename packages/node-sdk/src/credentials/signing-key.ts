import { z } from 'zod';

/** Exact UTF-8 bytes; whitespace is part of a signing key. */
export const signingKeyCredentialSchema = z
  .object({
    type: z.literal('hmac_key'),
    signingKey: z
      .string()
      .min(1)
      .max(4_096)
      .refine(
        (value) => value.isWellFormed(),
        'Signing keys must be valid Unicode text',
      )
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 4_096,
        'Signing keys must fit 4,096 UTF-8 bytes',
      ),
  })
  .strict()
  .readonly();
