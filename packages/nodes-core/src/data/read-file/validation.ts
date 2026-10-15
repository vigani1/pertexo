import {
  boundedNodeJsonSchema,
  nodeArtifactReferenceSchema,
} from '@pertexo/node-sdk';
import { z } from 'zod';

export const CORE_READ_FILE_CONFIG_SCHEMA = z.discriminatedUnion('format', [
  z.object({ format: z.literal('json') }).strict(),
  z
    .object({
      format: z.literal('csv'),
      delimiter: z.enum([',', ';', '\t']).meta({ title: 'Delimiter' }),
      convertValues: z.boolean().default(true).meta({
        title: 'Convert numbers and booleans',
        description:
          'On by default. Keep leading-zero identifiers, large numbers and empty cells as text. Turn off to keep all cells as text.',
      }),
    })
    .strict(),
]);
export const CORE_READ_FILE_INPUT_SCHEMA = z
  .object({
    file: nodeArtifactReferenceSchema
      .unwrap()
      .extend({ kind: z.literal('artifact') })
      .strict(),
  })
  .strict();
export const CORE_READ_FILE_OUTPUT_SCHEMA = boundedNodeJsonSchema;
export type CoreReadFileConfig = z.output<typeof CORE_READ_FILE_CONFIG_SCHEMA>;
export type CoreReadFileInput = z.output<typeof CORE_READ_FILE_INPUT_SCHEMA>;
