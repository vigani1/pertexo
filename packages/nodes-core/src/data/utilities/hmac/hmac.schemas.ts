import { z } from 'zod';
export const hmacConfigSchema = z
  .object({
    algorithm: z.enum(['sha256', 'sha512']),
    encoding: z.enum(['hex', 'base64']),
  })
  .strict();
export const hmacInputSchema = z.object({ value: z.string() }).strict();
export const hmacOutputSchema = z
  .object({ value: z.string().max(128) })
  .strict();
export type HmacConfig = z.output<typeof hmacConfigSchema>;
