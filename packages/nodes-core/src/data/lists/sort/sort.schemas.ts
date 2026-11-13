import { z } from 'zod';
import { labelledChoice } from '@pertexo/node-sdk';
import {
  collectionItemsSchema,
  collectionPathSchema,
  collectionCountSchema,
} from '../semantics/semantics.schemas.js';
export const CORE_SORT_CONFIG_SCHEMA = z
  .object({
    path: collectionPathSchema.meta({
      title: 'Sort by',
      description:
        'Use $ for each whole item, or a path like $.amount for one field.',
      default: '$',
    }),
    valueType: labelledChoice({ number: 'Numbers', text: 'Text' }).meta({
      title: 'Value type',
      description:
        'Numbers sort numerically. Text compares characters in a fixed, case-sensitive order.',
      default: 'number',
    }),
    direction: labelledChoice({
      ascending: 'Ascending',
      descending: 'Descending',
    }).meta({ title: 'Direction', default: 'ascending' }),
    missing: labelledChoice({ first: 'First', last: 'Last' }).meta({
      title: 'Missing or null fields',
      description: 'Keep these records first or last, regardless of direction.',
      default: 'last',
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
