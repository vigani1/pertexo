import { z } from 'zod';
import { COLLECTION_MAX_ITEMS } from '../../lists/semantics/validation.js';
export const htmlConfigSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('text'),
      selector: z.string().min(1).max(256),
      limit: z.number().int().min(1).max(COLLECTION_MAX_ITEMS),
    })
    .strict(),
  z
    .object({
      operation: z.literal('attribute'),
      selector: z.string().min(1).max(256),
      attribute: z.string().min(1).max(128),
      limit: z.number().int().min(1).max(COLLECTION_MAX_ITEMS),
    })
    .strict(),
]);
export const htmlInputSchema = z.object({ value: z.string() }).strict();
export const htmlOutputSchema = z
  .object({
    items: z.array(z.string()).max(COLLECTION_MAX_ITEMS),
    matchCount: z.number().int().min(0).max(8_000),
    truncated: z.boolean(),
  })
  .strict();
export type HtmlConfig = z.output<typeof htmlConfigSchema>;
