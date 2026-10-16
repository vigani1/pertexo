import {
  WEBHOOK_RESPONSE_HEADER_NAMES,
  type SchemaJson,
} from '@pertexo/node-sdk';
import { z } from 'zod';

export const CORE_RESPOND_WEBHOOK_CONFIG_SCHEMA = z
  .object({
    bodyType: z.enum(['json', 'text']).optional(),
  })
  .strict();
export const CORE_RESPOND_WEBHOOK_INPUT_SCHEMA = z
  .object({
    // The registry already snapshots bounded JSON; preserve body keys verbatim.
    body: z.unknown().nonoptional(),
    statusCode: z.number().int().min(200).max(599).optional(),
    headers: z
      .object(
        Object.fromEntries(
          WEBHOOK_RESPONSE_HEADER_NAMES.map((name) => [
            name,
            z
              .string()
              .max(1024)
              .regex(/^[\x20-\x7e]*$/u)
              .optional(),
          ]),
        ),
      )
      .strict()
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
