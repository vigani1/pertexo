import { z } from 'zod';
import { FILE_PAGE_LIMITS } from './page-limits.js';

export const FILE_INPUT_ERROR_CODE = 'execution.file_input';
const location = z
  .number()
  .int()
  .min(1)
  .max(FILE_PAGE_LIMITS.fileBytes + 1);
export const fileInputDiagnosticSchema = z.discriminatedUnion('reason', [
  z
    .object({
      reason: z.enum([
        'file_size',
        'inline_file_size',
        'page_value_size',
        'page_array',
        'page_item_count',
        'value_size',
        'item_count',
        'invalid_utf8',
        'json_number',
        'file_unavailable',
        'file_integrity',
        'csv_empty',
        'multipart_size',
        'multipart_values',
        'multipart_content_type',
        'multipart_boundary',
        'multipart_encoding',
      ]),
    })
    .strict(),
  z
    .object({ reason: z.literal('json_syntax'), position: location.optional() })
    .strict(),
  z
    .object({ reason: z.literal('csv_syntax'), line: location.optional() })
    .strict(),
  z
    .object({
      reason: z.enum(['blank_header', 'duplicate_header']),
      column: location,
    })
    .strict(),
  z
    .object({
      reason: z.literal('csv_columns'),
      record: location,
      expected: location,
      actual: location,
    })
    .strict(),
]);
export type FileInputDiagnostic = z.output<typeof fileInputDiagnosticSchema>;
