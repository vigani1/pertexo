import { z } from 'zod';
import {
  collectionItemsSchema,
  collectionPathSchema,
  collectionCountSchema,
} from '../semantics/validation.js';
export const CORE_SORT_CONFIG_SCHEMA = z
  .object({
    path: collectionPathSchema.meta({
      title: 'Sort by',
      description:
        'A field like price or order.total; $ sorts by the whole item.',
    }),
    valueType: z.enum(['number', 'text']).meta({
      title: 'Value type',
      description:
        'Present keys must match this type; text uses deterministic code-unit ordering.',
    }),
    direction: z.enum(['ascending', 'descending']).meta({ title: 'Direction' }),
    missing: z.enum(['first', 'last']).meta({
      title: 'Missing or null fields',
      description: 'Keep these records first or last, regardless of direction.',
    }),
  })
  .strict();
export const CORE_SORT_INPUT_SCHEMA = z
  .object({ items: collectionItemsSchema })
  .strict();
export const CORE_SORT_OUTPUT_SCHEMA = z
  .object({ items: collectionItemsSchema, inputCount: collectionCountSchema })
  .strict()
  .refine(
    (v) => v.items.length === v.inputCount,
    'Sort count must match its items',
  );
export type CoreSortConfig = z.output<typeof CORE_SORT_CONFIG_SCHEMA>;
export type CoreSortInput = z.output<typeof CORE_SORT_INPUT_SCHEMA>;
