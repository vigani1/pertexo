import { NODE_JSON_LIMITS } from '@pertexo/node-sdk';
import { parseJsonPath } from '@pertexo/workflow-model';
import { z } from 'zod';

// One-item batches use 2N+3 members, including their counts, under the SDK's 10,000-member bound.
export const COLLECTION_MAX_ITEMS = Math.floor(
  (NODE_JSON_LIMITS.members - 3) / 2,
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
export const collectionPathSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((path, context) => {
    const segments = parseJsonPath(path);
    if (
      new TextEncoder().encode(path).byteLength > 512 ||
      segments === undefined ||
      segments.length > 64
    )
      context.addIssue({
        code: 'custom',
        message:
          'Write the path like $.status or $.items[0].id, with at most 512 UTF-8 bytes and 64 segments',
      });
  })
  // Lets the editor accept a bare field name and store it as a path.
  .meta({ format: 'json-path' });
export const COLLECTION_SEMANTICS = Object.freeze([
  `Collections contain at most ${String(COLLECTION_MAX_ITEMS)} items; SDK admission bounds whole input/output to 1 MiB, depth 64 and 10000 members.`,
  'Paths use the platform own-property syntax, at most 512 UTF-8 bytes and 64 segments; null is distinct from a missing path.',
  'Collection operations preserve item data, never mutate their input, and check cancellation during bounded processing.',
] as const);
