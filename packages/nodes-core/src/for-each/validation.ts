import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import { z } from 'zod';

export const CORE_FOR_EACH_MAX_ITEMS = 1_000;

const itemsSchema = z
  .array(z.json())
  .max(CORE_FOR_EACH_MAX_ITEMS)
  .superRefine((items, context) => {
    if (!boundedNodeJsonSchema.safeParse({ items }).success)
      context.addIssue({
        code: 'custom',
        message: 'For Each items exceed the bounded node JSON contract',
      });
  });

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
