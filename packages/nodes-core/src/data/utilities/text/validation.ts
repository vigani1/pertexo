import { z } from 'zod';
import { COLLECTION_MAX_ITEMS } from '../../lists/semantics/validation.js';

export const textConfigSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('uppercase') }).strict(),
  z.object({ operation: z.literal('lowercase') }).strict(),
  z.object({ operation: z.literal('trim') }).strict(),
  z
    .object({
      operation: z.literal('replace'),
      all: z.boolean().meta({ title: 'Replace all matches' }),
    })
    .strict(),
  z.object({ operation: z.literal('split') }).strict(),
  z
    .object({
      operation: z.literal('truncate'),
      length: z
        .number()
        .int()
        .min(1)
        .max(1_048_576)
        .meta({ title: 'Maximum characters' }),
      ellipsis: z.boolean().meta({ title: 'Add ellipsis' }),
    })
    .strict(),
]);
export const textInputSchema = z
  .object({
    value: z.string(),
    search: z.string().optional(),
    replacement: z.string().optional(),
    delimiter: z.string().optional(),
  })
  .strict();
export const textOutputSchema = z
  .object({
    value: z.union([z.string(), z.array(z.string()).max(COLLECTION_MAX_ITEMS)]),
  })
  .strict();
export type TextConfig = z.output<typeof textConfigSchema>;
export type TextInput = z.output<typeof textInputSchema>;
