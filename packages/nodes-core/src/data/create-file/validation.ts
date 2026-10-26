import {
  nodeArtifactReferenceSchema,
  filePageReferenceSchema,
  FILE_PAGE_LIMITS,
  sheetNameSchema,
} from '@pertexo/node-sdk';
import { z } from 'zod';

import { COLLECTION_MAX_ITEMS } from '../lists/semantics/validation.js';
export const fileColumnNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((name) => name.trim() !== '', 'Column names cannot be blank.');
const fileColumnsSchema = z
  .array(fileColumnNameSchema)
  .max(COLLECTION_MAX_ITEMS)
  .refine(
    (columns) => new Set(columns).size === columns.length,
    'Choose each column once.',
  );
export const CORE_CREATE_FILE_CONFIG_SCHEMA = z.discriminatedUnion('format', [
  z
    .object({
      format: z.literal('json'),
      inputMode: z.literal('pages').optional(),
    })
    .strict(),
  z.object({ format: z.literal('text') }).strict(),
  z
    .object({
      format: z.literal('csv'),
      inputMode: z.literal('pages').optional(),
      delimiter: z.enum([',', ';', '\t']),
      columns: fileColumnsSchema,
    })
    .strict(),
  z
    .object({
      format: z.literal('xlsx'),
      inputMode: z.literal('pages').optional(),
      sheetName: sheetNameSchema.default('Sheet1').meta({
        title: 'Sheet name',
      }),
      columns: fileColumnsSchema,
    })
    .strict(),
]);
export const CORE_CREATE_FILE_INPUT_SCHEMA = z.union([
  z.object({ data: z.json() }).strict(),
  z
    .object({
      pages: z
        .array(filePageReferenceSchema)
        .max(FILE_PAGE_LIMITS.pages)
        .readonly(),
    })
    .strict(),
]);
export const CORE_CREATE_FILE_OUTPUT_SCHEMA = z
  .object({
    file: nodeArtifactReferenceSchema
      .unwrap()
      .extend({ kind: z.literal('artifact') })
      .strict(),
  })
  .strict();
export type CoreCreateFileConfig = z.output<
  typeof CORE_CREATE_FILE_CONFIG_SCHEMA
>;
export type CoreCreateFileInput = z.output<
  typeof CORE_CREATE_FILE_INPUT_SCHEMA
>;
