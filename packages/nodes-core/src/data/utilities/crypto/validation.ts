import { z } from 'zod';
export const cryptoConfigSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('hash'),
      algorithm: z.enum(['sha256', 'sha512', 'md5']).meta({
        description:
          'MD5 is not for security. Use SHA-256 or SHA-512 for security-sensitive hashes.',
      }),
      encoding: z.enum(['hex', 'base64']),
    })
    .strict(),
  z.object({ operation: z.literal('uuid') }).strict(),
  z
    .object({
      operation: z.literal('random_id'),
      length: z.number().int().min(1).max(256),
    })
    .strict(),
]);
export const cryptoInputSchema = z
  .object({ value: z.string().optional() })
  .strict();
export const cryptoOutputSchema = z
  .object({ value: z.string().max(256) })
  .strict();
export type CryptoConfig = z.output<typeof cryptoConfigSchema>;
