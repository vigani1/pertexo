import { parseJsonPath } from '@pertexo/workflow-model';
import { z } from 'zod';

export const COLLECTION_MAX_ITEMS = 1_000;
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
          'Use an own-property JSON path with at most 512 UTF-8 bytes and 64 segments',
      });
  });
export const COLLECTION_SEMANTICS = Object.freeze([
  'Collections contain at most 1000 items; the existing SDK admission bounds the whole JSON envelope to 1 MiB, depth 64 and 10000 members.',
  'Paths use the platform own-property syntax, at most 512 UTF-8 bytes and 64 segments; null is distinct from a missing path.',
  'Collection operations preserve item data, never mutate their input, and check cancellation during bounded processing.',
] as const);
