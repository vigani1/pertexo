import {
  formatByteSize,
  formatCount,
  NODE_JSON_LIMITS,
} from '@pertexo/node-sdk';
import { COLLECTION_PATH_LIMITS } from '@pertexo/workflow-model';
import { z } from 'zod';

// One-item batches use 2N+3 members, including their counts, under the SDK's
// member bound.
const ONE_ITEM_BATCH_MEMBERS = Object.freeze({ perItem: 2, fixed: 3 });
export const COLLECTION_MAX_ITEMS = Math.floor(
  (NODE_JSON_LIMITS.members - ONE_ITEM_BATCH_MEMBERS.fixed) /
    ONE_ITEM_BATCH_MEMBERS.perItem,
);
export const collectionItemsSchema = z
  .array(z.json())
  .max(COLLECTION_MAX_ITEMS);
export const collectionCountSchema = z
  .number()
  .int()
  .min(0)
  .max(COLLECTION_MAX_ITEMS);
export const collectionScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
export const COLLECTION_SEMANTICS = Object.freeze([
  `Collections contain at most ${formatCount(COLLECTION_MAX_ITEMS)} items; SDK admission bounds whole input/output to ${formatByteSize(NODE_JSON_LIMITS.bytes)}, depth ${String(NODE_JSON_LIMITS.depth)} and ${formatCount(NODE_JSON_LIMITS.members)} members.`,
  `Paths use the platform own-property syntax, at most ${formatByteSize(COLLECTION_PATH_LIMITS.bytes)} of UTF-8 and ${String(COLLECTION_PATH_LIMITS.segments)} segments; null is distinct from a missing path.`,
  'Collection operations preserve item data, never mutate their input, and check cancellation during bounded processing.',
] as const);
