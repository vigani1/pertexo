import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import { z } from 'zod';

export const CORE_FOR_EACH_MAX_ITEMS = 1_000;

const boundedItemsSnapshotSchema = z.unknown().transform((items, context) => {
  const bounded = boundedNodeJsonSchema.safeParse({ items });
  if (!bounded.success) {
    context.addIssue({
      code: 'custom',
      message: 'For Each items exceed the bounded node JSON contract',
    });
    return z.NEVER;
  }
  if (
    bounded.data === null ||
    typeof bounded.data !== 'object' ||
    Array.isArray(bounded.data) ||
    !Object.hasOwn(bounded.data, 'items')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'For Each items exceed the bounded node JSON contract',
    });
    return z.NEVER;
  }
  return (bounded.data as { readonly items: unknown }).items;
});

const itemsSchema = boundedItemsSnapshotSchema.pipe(
  z.array(z.json()).max(CORE_FOR_EACH_MAX_ITEMS),
);

export const CORE_FOR_EACH_CONFIG_SCHEMA = z.object({}).strict();
export const CORE_FOR_EACH_INPUT_SCHEMA = z
  .object({ items: itemsSchema })
  .strict();
export const CORE_FOR_EACH_OUTPUT_SCHEMA = z
  .object({
    items: itemsSchema,
    iterationCount: z.number().int().min(0).max(CORE_FOR_EACH_MAX_ITEMS),
  })
  .strict()
  .superRefine(({ items, iterationCount }, context) => {
    if (iterationCount !== items.length)
      context.addIssue({
        code: 'custom',
        path: ['iterationCount'],
        message: 'For Each iteration count must equal item count',
      });
  });

export type CoreForEachInput = Readonly<
  z.output<typeof CORE_FOR_EACH_INPUT_SCHEMA>
>;
