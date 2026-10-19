import { z } from 'zod';
import {
  collectionItemsSchema,
  collectionPathSchema,
  collectionScalarSchema,
  collectionCountSchema,
} from '../semantics/validation.js';
export const CORE_FILTER_CONFIG_SCHEMA = z
  .object({
    path: collectionPathSchema.meta({
      title: 'Item path',
      description:
        'A field like status or order.total; $ selects the whole item.',
    }),
    operator: z
      .enum([
        'equals',
        'not_equals',
        'less_than',
        'less_or_equal',
        'greater_than',
        'greater_or_equal',
        'contains',
        'exists',
        'not_exists',
      ])
      .meta({
        title: 'Comparison',
        description:
          'Map comparison value on Inputs, except for exists/not exists. Missing fields never match comparisons.',
      }),
  })
  .strict();
export const CORE_FILTER_INPUT_SCHEMA = z
  .object({
    items: collectionItemsSchema,
    value: collectionScalarSchema.optional(),
  })
  .strict();
export const CORE_FILTER_OUTPUT_SCHEMA = z
  .object({
    items: collectionItemsSchema,
    inputCount: collectionCountSchema,
    removedCount: collectionCountSchema,
  })
  .strict()
  .refine(
    (v) => v.items.length + v.removedCount === v.inputCount,
    'Filter counts must match its items',
  );
export type CoreFilterConfig = z.output<typeof CORE_FILTER_CONFIG_SCHEMA>;
export type CoreFilterInput = z.output<typeof CORE_FILTER_INPUT_SCHEMA>;
