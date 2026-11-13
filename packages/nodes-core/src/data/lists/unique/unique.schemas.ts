import { z } from 'zod';
import { labelledChoice } from '@pertexo/node-sdk';
import {
  collectionItemsSchema,
  collectionPathSchema,
  collectionCountSchema,
} from '../semantics/semantics.schemas.js';
export const CORE_UNIQUE_CONFIG_SCHEMA = z
  .object({
    path: collectionPathSchema.meta({
      title: 'Compare by',
      description:
        'Use $ to compare whole items, or a field like $.id. Keep the first item for each equal value.',
      default: '$',
    }),
    missing: labelledChoice({
      error: 'Fail on missing keys',
      skip: 'Skip missing keys',
    }).meta({
      title: 'Missing keys',
      description:
        'Fail on missing keys, or explicitly skip and count those records. Null is a real key.',
      default: 'error',
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
