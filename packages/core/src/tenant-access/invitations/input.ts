import { z } from 'zod';

// The sealed invitation token's encoded parts, as the API seals them.
const SEALED_TOKEN_CHARACTERS = Object.freeze({
  ciphertext: 16_384,
  nonce: 128,
  tag: 256,
  keyVersion: 64,
});

export const sealedToken = z
  .object({
    ciphertext: z.string().min(1).max(SEALED_TOKEN_CHARACTERS.ciphertext),
    nonce: z.string().min(1).max(SEALED_TOKEN_CHARACTERS.nonce),
    tag: z.string().min(1).max(SEALED_TOKEN_CHARACTERS.tag),
    keyVersion: z.string().min(1).max(SEALED_TOKEN_CHARACTERS.keyVersion),
  })
  .strict();
