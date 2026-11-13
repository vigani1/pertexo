import { z } from 'zod';
import { labelledChoice } from '@pertexo/node-sdk';
export const cryptoConfigSchema = z
  .discriminatedUnion('operation', [
    z
      .object({
        operation: z.literal('hash').meta({ title: 'Hash text' }),
        algorithm: labelledChoice({
          sha256: 'SHA-256',
          sha512: 'SHA-512',
          md5: 'MD5 · not for security',
        }).meta({
          description:
            'MD5 is not for security. Use SHA-256 or SHA-512 for security-sensitive hashes.',
          default: 'sha256',
        }),
        encoding: z.enum(['hex', 'base64']).meta({ default: 'hex' }),
      })
      .strict(),
    z.object({ operation: z.literal('uuid').meta({ title: 'UUID' }) }).strict(),
    z
      .object({
        operation: z.literal('random_id').meta({ title: 'Random ID' }),
        length: z.number().int().min(1).max(256).meta({ default: 24 }),
      })
      .strict(),
  ])
  .meta({
    description:
      'MD5 is not for security. UUID and random IDs change whenever this step runs again.',
    default: { operation: 'hash', algorithm: 'sha256', encoding: 'hex' },
  });
export const cryptoInputSchema = z
  .object({ value: z.string().optional() })
  .strict();
export const cryptoOutputSchema = z
  .object({ value: z.string().max(256) })
  .strict();
export type CryptoConfig = z.output<typeof cryptoConfigSchema>;
