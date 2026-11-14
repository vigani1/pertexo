import { z } from 'zod';
import { labelledChoice } from '@pertexo/node-sdk';
import { outputEncodingSchema } from '../encoding.schemas.js';

// A SHA-512 HMAC in hex is 128 characters, the longest output.
const HMAC_OUTPUT_CHARACTERS = 128;
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
  .object({ value: z.string().max(HMAC_OUTPUT_CHARACTERS) })
  .strict();
export type HmacConfig = z.output<typeof hmacConfigSchema>;
