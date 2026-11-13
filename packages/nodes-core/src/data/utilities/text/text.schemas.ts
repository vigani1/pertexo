import { z } from 'zod';
import { COLLECTION_MAX_ITEMS } from '../../lists/semantics/semantics.schemas.js';

export const textConfigSchema = z
  .discriminatedUnion('operation', [
    z
      .object({
        operation: z.literal('uppercase').meta({ title: 'Uppercase' }),
      })
      .strict(),
    z
      .object({
        operation: z.literal('lowercase').meta({ title: 'Lowercase' }),
      })
      .strict(),
    z
      .object({
        operation: z.literal('trim').meta({ title: 'Trim whitespace' }),
      })
      .strict(),
    z
      .object({
        operation: z.literal('replace').meta({ title: 'Replace text' }),
        all: z.boolean().meta({ title: 'Replace all matches', default: true }),
      })
      .strict(),
    z
      .object({ operation: z.literal('split').meta({ title: 'Split text' }) })
      .strict(),
    z
      .object({
        operation: z.literal('truncate').meta({ title: 'Truncate text' }),
        length: z
          .number()
          .int()
          .min(1)
          .max(1_048_576)
          .meta({ title: 'Maximum characters', default: 100 }),
        ellipsis: z.boolean().meta({ title: 'Add ellipsis', default: true }),
      })
      .strict(),
  ])
  .meta({
    description:
      'Map text in Inputs. Replace uses Search and Replacement; Split uses Delimiter. Matches are literal, never regex.',
    default: { operation: 'trim' },
  });
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
