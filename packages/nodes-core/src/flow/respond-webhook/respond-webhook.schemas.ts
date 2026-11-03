import {
  isWebhookResponseHeaderAllowed,
  type SchemaJson,
} from '@pertexo/node-sdk';
import { z } from 'zod';

export const CORE_RESPOND_WEBHOOK_CONFIG_SCHEMA = z
  .object({
    bodyType: z.enum(['json', 'text']).optional(),
    // Only types a browser can't run: XML can carry XHTML, SVG or a stylesheet,
    // and `/hooks` shares the app's origin.
    textContentType: z.enum(['text/plain', 'text/csv']).optional(),
  })
  .strict();
export const CORE_RESPOND_WEBHOOK_INPUT_SCHEMA = z
  .object({
    // The registry already snapshots bounded JSON; preserve body keys verbatim.
    body: z.unknown().nonoptional(),
    statusCode: z.number().int().min(200).max(599).optional(),
    headers: z
      .preprocess(
        (value, context) => {
          // Zod records omit __proto__; refuse it explicitly instead of accepting a changed header map.
          if (
            value !== null &&
            typeof value === 'object' &&
            Object.hasOwn(value, '__proto__')
          )
            context.addIssue({
              code: 'custom',
              message: 'A webhook response cannot set __proto__.',
            });
          return value;
        },
        z
          .record(
            z
              .string()
              .min(1)
              .max(64)
              .refine(
                isWebhookResponseHeaderAllowed,
                'Use a safe named header or a non-reserved x- header.',
              ),
            z
              .string()
              .max(1024)
              .regex(/^[\x20-\x7e]*$/u),
          )
          .refine(
            (headers) => Object.keys(headers).length <= 16,
            'Use at most 16 headers.',
          )
          .refine(
            (headers) =>
              new Set(Object.keys(headers).map((name) => name.toLowerCase()))
                .size === Object.keys(headers).length,
            'Header names must be distinct, regardless of case.',
          ),
      )
      .optional(),
  })
  .strict();
export const CORE_RESPOND_WEBHOOK_OUTPUT_SCHEMA = z
  .object({
    outcome: z.enum([
      'responded',
      'already_responded',
      'not_waiting',
      'preview',
    ]),
    statusCode: z.number().int().min(200).max(599).nullable(),
  })
  .strict();
export type CoreRespondWebhookConfig = z.output<
  typeof CORE_RESPOND_WEBHOOK_CONFIG_SCHEMA
>;
export type CoreRespondWebhookInput = z.output<
  typeof CORE_RESPOND_WEBHOOK_INPUT_SCHEMA
> &
  Readonly<{ body: SchemaJson }>;
