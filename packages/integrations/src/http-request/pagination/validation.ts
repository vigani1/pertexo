import { z } from 'zod';
import { collectionPathSchema } from '@pertexo/workflow-model';

const parameter = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9._-]*$/u);
const counter = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 100);
const common = {
  itemsPath: collectionPathSchema.meta({
    title: 'Items path',
    description: 'The list on each page, for example $.data or $.',
  }),
  maxPages: z.number().int().min(1).max(100).default(10),
  delayMillis: z.number().int().min(0).max(10_000).default(0),
};
export const httpPaginationSchema = z
  .discriminatedUnion('mode', [
    z
      .object({
        ...common,
        mode: z.literal('next_link'),
        source: z.discriminatedUnion('kind', [
          z
            .object({ kind: z.literal('body'), path: collectionPathSchema })
            .strict(),
          z.object({ kind: z.literal('link_header') }).strict(),
        ]),
      })
      .strict(),
    z
      .object({
        ...common,
        mode: z.literal('cursor'),
        cursorPath: collectionPathSchema,
        parameter,
      })
      .strict(),
    z
      .object({
        ...common,
        mode: z.literal('page'),
        parameter,
        start: counter.default(1),
      })
      .strict(),
    z
      .object({
        ...common,
        mode: z.literal('offset'),
        parameter,
        start: counter.default(0),
        step: z
          .number()
          .int()
          .min(1)
          .max(Math.floor(Number.MAX_SAFE_INTEGER / 100)),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.mode === 'offset' &&
      !Number.isSafeInteger(value.start + value.maxPages * value.step)
    )
      context.addIssue({
        code: 'custom',
        path: ['step'],
        message:
          'The first offset, step and Max pages must stay within whole-number precision',
      });
  });

export type HttpPagination = z.output<typeof httpPaginationSchema>;
