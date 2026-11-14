import { z } from 'zod';
import { collectionPathSchema } from '@pertexo/workflow-model';
import {
  FILE_PAGE_LIMITS,
  formatByteSize,
  formatCount,
  NODE_JSON_LIMITS,
} from '@pertexo/node-sdk';

/** HTTP pagination bounds; the request output and its failures read them too. */
export const HTTP_PAGINATION_LIMITS = Object.freeze({
  maxPages: 100,
  defaultPages: 10,
  maxDelayMillis: 10_000,
  keyCharacters: 128,
});

const parameter = z
  .string()
  .min(1)
  .max(HTTP_PAGINATION_LIMITS.keyCharacters)
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
  .max(Number.MAX_SAFE_INTEGER - HTTP_PAGINATION_LIMITS.maxPages);
const common = {
  outputMode: z
    .literal('pages')
    .optional()
    .meta({
      title: 'Save items as pages',
      description: `Store up to ${formatByteSize(FILE_PAGE_LIMITS.totalBytes)} / ${formatCount(FILE_PAGE_LIMITS.totalItems)} records as JSON-array file pages instead of one inline list.`,
    }),
  itemsPath: collectionPathSchema.meta({
    title: 'Items path',
    description: 'The list on each page, for example $.data or $',
  }),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(HTTP_PAGINATION_LIMITS.maxPages)
    .default(HTTP_PAGINATION_LIMITS.defaultPages)
    .meta({
      title: 'Max pages',
      description: `Stop after at most ${String(HTTP_PAGINATION_LIMITS.maxPages)} pages. Inline output must fit ${formatByteSize(NODE_JSON_LIMITS.bytes)}; Save items as pages supports up to ${formatByteSize(FILE_PAGE_LIMITS.totalBytes)}.`,
    }),
  delayMillis: z
    .number()
    .int()
    .min(0)
    .max(HTTP_PAGINATION_LIMITS.maxDelayMillis)
    .default(0)
    .meta({
      title: 'Delay between pages',
      description: `Pause before fetching the next page, up to ${String(HTTP_PAGINATION_LIMITS.maxDelayMillis / 1_000)} seconds.`,
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
          .max(
            Math.floor(
              Number.MAX_SAFE_INTEGER / HTTP_PAGINATION_LIMITS.maxPages,
            ),
          )
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
