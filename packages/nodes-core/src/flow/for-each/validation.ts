import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/workflow-model';
import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import { z } from 'zod';

export const CORE_FOR_EACH_MAX_ITEMS =
  WORKFLOW_GRAPH_CONTRACT_LIMITS.maxLoopIterations;

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
// Steps after the loop also see `results`, added when they read its output:
// each pass's result in item order, null where a pass skipped the body's
// last step.
export const CORE_FOR_EACH_OUTPUT_SCHEMA = z
  .object({
    items: itemsSchema,
    iterationCount: z.number().int().min(0).max(CORE_FOR_EACH_MAX_ITEMS),
    results: z
      .array(z.json())
      .max(CORE_FOR_EACH_MAX_ITEMS)
      .optional()
      .describe(
        "Each pass's result, in item order: what the loop's last step returned, or null where a pass skipped it.",
      ),
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
