import { z } from 'zod';

export const FILE_INPUT_ERROR_CODE = 'execution.file_input';
const location = z.number().int().min(1).max(1_048_577);
export const fileInputDiagnosticSchema = z.discriminatedUnion('reason', [
  z
    .object({
      reason: z.enum([
        'file_size',
        'value_size',
        'item_count',
        'invalid_utf8',
        'json_number',
        'file_unavailable',
        'file_integrity',
        'csv_empty',
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
      reason: z.enum(['csv_blank_header', 'csv_duplicate_header']),
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
