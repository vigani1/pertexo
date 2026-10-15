import { z } from 'zod';
import { inspectJsonValue } from '../json/canonical.js';
import { storageTextSchema } from '../json/text.js';
import { parseFormValues } from '../forms/values.js';
import type { FormField } from '../forms/fields.js';

const scalar = z.union([storageTextSchema, z.number(), z.boolean(), z.null()]);
export const taskDetailsSchema = z
  .record(
    storageTextSchema
      .min(1)
      .max(160)
      .refine((value) => value.trim().length > 0, 'Give each detail a name.'),
    scalar,
  )
  .refine(
    (value) => Object.keys(value).length <= 20,
    'Use at most 20 detail fields.',
  )
  .refine((value) => {
    const { bytes, members } = inspectJsonValue(value);
    return bytes + 2 * members <= 8_192;
  }, 'Keep task details within 8 KB; include only the facts needed to respond.');

const prefillSchema = z.record(
  z.string(),
  z.union([storageTextSchema, z.number(), z.boolean()]),
);
export const taskContextSchema = z
  .object({
    details: taskDetailsSchema.optional(),
    prefill: prefillSchema.optional(),
  })
  .strict()
  .refine((value) => {
    const { bytes, members } = inspectJsonValue(value);
    return bytes + 2 * members <= 73_728;
  }, 'Keep task context within 72 KB; shorten the details or prefilled values.');

/** Prefills are partial responses; every supplied value uses the submission rule. */
export function parseTaskPrefill(fields: readonly FormField[], input: unknown) {
  return parseFormValues(
    fields.map((field) => ({ ...field, required: false })),
    input,
  );
}
export type TaskContext = z.output<typeof taskContextSchema>;
