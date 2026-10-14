import { z } from 'zod';
import {
  collectionItemsSchema,
  collectionCountSchema,
  COLLECTION_MAX_ITEMS,
} from '../semantics/validation.js';
export const CORE_TAKE_CONFIG_SCHEMA = z
  .object({
    count: z.number().int().min(0).max(COLLECTION_MAX_ITEMS).meta({
      title: 'Items to keep',
      description:
        'Keep the first N items. Zero keeps none; a larger count keeps all available items.',
    }),
  })
  .strict();
export const CORE_TAKE_INPUT_SCHEMA = z
  .object({ items: collectionItemsSchema })
  .strict();
export const CORE_TAKE_OUTPUT_SCHEMA = z
  .object({
    items: collectionItemsSchema,
    inputCount: collectionCountSchema,
    removedCount: collectionCountSchema,
  })
  .strict();
export type CoreTakeConfig = z.output<typeof CORE_TAKE_CONFIG_SCHEMA>;
export type CoreTakeInput = z.output<typeof CORE_TAKE_INPUT_SCHEMA>;
