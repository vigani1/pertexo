import { NODE_JSON_LIMITS } from '@pertexo/node-sdk/pure';

// One-item batches use 2N+3 members, including their counts, under the SDK's
// member bound.
const ONE_ITEM_BATCH_MEMBERS = Object.freeze({ perItem: 2, fixed: 3 });
export const COLLECTION_MAX_ITEMS = Math.floor(
  (NODE_JSON_LIMITS.members - ONE_ITEM_BATCH_MEMBERS.fixed) /
    ONE_ITEM_BATCH_MEMBERS.perItem,
);
