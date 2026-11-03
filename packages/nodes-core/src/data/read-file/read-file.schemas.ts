import {
  boundedNodeJsonSchema,
  filePageBundleSchema,
  nodeArtifactReferenceSchema,
  sheetNameSchema,
} from '@pertexo/node-sdk';
import { z } from 'zod';

export const CORE_READ_FILE_CONFIG_SCHEMA = z.discriminatedUnion('format', [
  z
    .object({
      format: z.literal('json'),
      outputMode: z.literal('pages').optional().meta({
        title: 'Output pages',
        description:
          'Store up to 10 MB as small JSON-array files. Map pages to an outer For Each, then Read file each page as inline data.',
      }),
    })
    .strict(),
  z
    .object({
      format: z.literal('csv'),
      outputMode: z.literal('pages').optional().meta({ title: 'Output pages' }),
      delimiter: z.enum([',', ';', '\t']).meta({ title: 'Delimiter' }),
      convertValues: z.boolean().default(true).meta({
        title: 'Convert numbers and booleans',
        description:
          'On by default. Keep leading-zero identifiers, large numbers and empty cells as text. Turn off to keep all cells as text.',
      }),
    })
    .strict(),
  z
    .object({
      format: z.literal('xlsx'),
      outputMode: z.literal('pages').optional().meta({ title: 'Output pages' }),
      sheet: sheetNameSchema.optional().meta({
        title: 'Sheet',
        description:
          'The sheet to read, by name. Leave empty to read the first visible sheet.',
      }),
      headerRow: z.number().int().min(1).max(1_048_576).default(1).meta({
        title: 'Header row',
        description:
          'The row with the column names. Rows above it are skipped.',
      }),
      convertValues: z.boolean().default(true).meta({
        title: 'Convert numbers and booleans',
        description:
          'On by default: number and TRUE/FALSE cells keep their type, and text cells stay text. Turn off to get every cell as text.',
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
export const CORE_READ_FILE_OUTPUT_SCHEMA = z.union([
  boundedNodeJsonSchema,
  filePageBundleSchema,
]);
export type CoreReadFileConfig = z.output<typeof CORE_READ_FILE_CONFIG_SCHEMA>;
export type CoreReadFileInput = z.output<typeof CORE_READ_FILE_INPUT_SCHEMA>;
