import { z } from 'zod';
import { collectionPathSchema } from '@pertexo/workflow-model';

const parameter = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z_][A-Za-z0-9._-]*$/u,
    'Use a query parameter name like page, offset or cursor.',
  )
  .meta({
    title: 'Query parameter',
    description: 'The query parameter your service uses for the next page.',
  });
const counter = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 100);
const common = {
  itemsPath: collectionPathSchema.meta({
    title: 'Items path',
    description: 'The list on each page, for example $.data or $',
  }),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .meta({
      title: 'Max pages',
      description:
        'Stop after at most 100 pages. The combined output must fit 1 MB.',
    }),
  delayMillis: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(0)
    .meta({
      title: 'Delay between pages',
      description: 'Pause before fetching the next page, up to 10 seconds.',
    }),
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
        cursorPath: collectionPathSchema.meta({ title: 'Next cursor path' }),
        parameter,
      })
      .strict(),
    z
      .object({
        ...common,
        mode: z.literal('page'),
        parameter,
        start: counter.default(1).meta({ title: 'First page' }),
      })
      .strict(),
    z
      .object({
        ...common,
        mode: z.literal('offset'),
        parameter,
        start: counter.default(0).meta({ title: 'First offset' }),
        step: z
          .number()
          .int()
          .min(1)
          .max(Math.floor(Number.MAX_SAFE_INTEGER / 100))
          .meta({
            title: 'Offset step',
            description:
              'Match the number of items your service returns per page.',
          }),
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
