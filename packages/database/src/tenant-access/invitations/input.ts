import { DELEGATED_ROLES } from '@pertexo/workflow-model';
import { z } from 'zod';

export const delegatedRole = z.enum(DELEGATED_ROLES);

export const revision = z.number().int().positive();

export const sealedToken = z
  .object({
    ciphertext: z.string().min(1).max(16_384),
    nonce: z.string().min(1).max(128),
    tag: z.string().min(1).max(256),
    keyVersion: z.string().min(1).max(64),
  })
  .strict();

export function normalizeEmail(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}
