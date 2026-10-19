import { z } from 'zod';
import {
  collectionItemsSchema,
  collectionPathSchema,
  collectionCountSchema,
  collectionScalarSchema,
  COLLECTION_MAX_ITEMS,
} from '../semantics/validation.js';
export const CORE_SUMMARIZE_CONFIG_SCHEMA = z
  .object({
    valuePath: collectionPathSchema.meta({
      title: 'Numeric value',
      description:
        'A number field like amount; $ selects numeric items. Numeric strings are not coerced; use Number conversion in an expression first.',
    }),
    groupBy: collectionPathSchema.optional().meta({
      title: 'Group by',
      description:
        'Optional field like region. Groups keep first-seen order; leave empty for one summary.',
    }),
    missing: z.enum(['error', 'skip']).meta({
      title: 'Missing values',
      description:
        'Fail on missing/null numbers or missing group keys, or explicitly skip and count them. Wrong types still fail.',
    }),
  })
  .strict();
export const CORE_SUMMARIZE_INPUT_SCHEMA = z
  .object({ items: collectionItemsSchema })
  .strict();
const groupSchema = z
  .object({
    key: collectionScalarSchema,
    count: collectionCountSchema,
    sum: z.number(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    average: z.number().nullable(),
  })
  .strict();
export const CORE_SUMMARIZE_OUTPUT_SCHEMA = z
  .object({
    groups: z.array(groupSchema).max(COLLECTION_MAX_ITEMS),
    inputCount: collectionCountSchema,
    skippedCount: collectionCountSchema,
  })
  .strict()
  .refine(
    (v) =>
      v.groups.reduce((count, group) => count + group.count, 0) +
        v.skippedCount ===
      v.inputCount,
    'Summary counts must match its groups',
  );
export type CoreSummarizeConfig = z.output<typeof CORE_SUMMARIZE_CONFIG_SCHEMA>;
export type CoreSummarizeInput = z.output<typeof CORE_SUMMARIZE_INPUT_SCHEMA>;
