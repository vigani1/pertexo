import { z } from 'zod';
import { labelledChoice } from '@pertexo/node-sdk';
import { outputEncodingSchema } from '../encoding.schemas.js';
export const hmacConfigSchema = z
  .object({
    algorithm: labelledChoice({ sha256: 'SHA-256', sha512: 'SHA-512' }).meta({
      default: 'sha256',
    }),
    encoding: outputEncodingSchema,
  })
  .strict();
export const hmacInputSchema = z.object({ value: z.string() }).strict();
export const hmacOutputSchema = z
  .object({ value: z.string().max(128) })
  .strict();
export type HmacConfig = z.output<typeof hmacConfigSchema>;
