import { z } from 'zod';
import {
  collectionItemsSchema,
  collectionCountSchema,
} from '../semantics/validation.js';
export const CORE_CONCAT_CONFIG_SCHEMA = z.object({}).strict();
export const CORE_CONCAT_INPUT_SCHEMA = z
  .object({ items: collectionItemsSchema, otherItems: collectionItemsSchema })
  .strict();
export const CORE_CONCAT_OUTPUT_SCHEMA = z
  .object({ items: collectionItemsSchema, inputCount: collectionCountSchema })
  .strict();
export type CoreConcatConfig = z.output<typeof CORE_CONCAT_CONFIG_SCHEMA>;
export type CoreConcatInput = z.output<typeof CORE_CONCAT_INPUT_SCHEMA>;
