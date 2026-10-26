import { z } from 'zod';
import { FILE_PAGE_LIMITS } from './page-limits.js';

export const FILE_INPUT_ERROR_CODE = 'execution.file_input';
const location = z
  .number()
  .int()
  .min(1)
  .max(FILE_PAGE_LIMITS.fileBytes + 1);
/** Excel's own sheet-name limit; longer names only come from crafted files. */
export const SHEET_NAME_MAX_LENGTH = 31;
/** A missing-sheet failure lists this many names so a test shows real ones. */
export const SHEET_NAME_SUGGESTIONS = 20;
// Counted in code points plus a closing ellipsis; one may take two units.
const sheetName = z
  .string()
  .min(1)
  .max(SHEET_NAME_MAX_LENGTH * 2 + 1)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
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
        'spreadsheet_too_large',
        'unsupported_spreadsheet',
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
      reason: z.literal('sheet_missing'),
      sheets: z.array(sheetName).max(SHEET_NAME_SUGGESTIONS),
      more: z.number().int().min(0).max(256),
    })
    .strict(),
  z.object({ reason: z.literal('sheet_header_row'), row: location }).strict(),
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
