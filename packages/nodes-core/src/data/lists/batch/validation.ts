import { z } from 'zod';
import {
  collectionItemsSchema,
  collectionCountSchema,
  COLLECTION_MAX_ITEMS,
} from '../semantics/validation.js';
export const CORE_BATCH_CONFIG_SCHEMA = z
  .object({
    size: z.number().int().min(1).max(COLLECTION_MAX_ITEMS).meta({
      title: 'Items per batch',
      description: 'Positive integer. Each batch keeps original order.',
    }),
  })
  .strict();
export const CORE_BATCH_INPUT_SCHEMA = z
  .object({ items: collectionItemsSchema })
  .strict();
export const CORE_BATCH_OUTPUT_SCHEMA = z
  .object({
    batches: z.array(collectionItemsSchema).max(COLLECTION_MAX_ITEMS),
    inputCount: collectionCountSchema,
    batchCount: collectionCountSchema,
  })
  .strict();
export type CoreBatchConfig = z.output<typeof CORE_BATCH_CONFIG_SCHEMA>;
export type CoreBatchInput = z.output<typeof CORE_BATCH_INPUT_SCHEMA>;
