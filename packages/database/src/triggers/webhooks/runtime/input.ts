import { z } from 'zod';

export const sealedSchema = z
  .object({
    id: z.uuid(),
    kmsKeyReference: z.string().min(1).max(2048),
    encryptedDataKey: z.string().min(1),
    ciphertext: z.string().min(1),
    nonce: z.string().min(1).max(64),
    authTag: z.string().min(1).max(64),
  })
  .strict();
