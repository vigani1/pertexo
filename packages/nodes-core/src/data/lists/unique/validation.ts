import { z } from 'zod';
import {
  collectionItemsSchema,
  collectionPathSchema,
  collectionCountSchema,
} from '../semantics/validation.js';
export const CORE_UNIQUE_CONFIG_SCHEMA = z
  .object({
    path: collectionPathSchema.meta({
      title: 'Compare by',
      description:
        '$ compares the whole item. The first equal value is kept; object key order is ignored.',
    }),
    missing: z.enum(['error', 'skip']).meta({
      title: 'Missing keys',
      description:
        'Fail on missing keys, or explicitly skip and count those records. Null is a real key.',
    }),
  })
  .strict();
export const CORE_UNIQUE_INPUT_SCHEMA = z
  .object({ items: collectionItemsSchema })
  .strict();
export const CORE_UNIQUE_OUTPUT_SCHEMA = z
  .object({
    items: collectionItemsSchema,
    inputCount: collectionCountSchema,
    duplicateCount: collectionCountSchema,
    skippedCount: collectionCountSchema,
  })
  .strict()
  .refine(
    (v) => v.items.length + v.duplicateCount + v.skippedCount === v.inputCount,
    'Unique counts must match its items',
  );
export type CoreUniqueConfig = z.output<typeof CORE_UNIQUE_CONFIG_SCHEMA>;
export type CoreUniqueInput = z.output<typeof CORE_UNIQUE_INPUT_SCHEMA>;
