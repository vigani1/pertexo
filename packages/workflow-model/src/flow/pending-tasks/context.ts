import { z } from 'zod';
import { inspectJsonValue } from '../../values/json/canonical.js';
import { storageTextSchema } from '../../values/json/text.js';
import {
  parseFormValues,
  formValuesSchema,
  FormValuesInvalidError,
} from '../../triggers/forms/values.js';
import type { FormField } from '../../triggers/forms/fields.js';

const scalar = z.union([storageTextSchema, z.number(), z.boolean(), z.null()]);
export const taskDetailsSchema = z
  .record(
    storageTextSchema
      .min(1)
      .max(160)
      .refine((value) => value.trim().length > 0, 'Give each detail a name.'),
    z.union([scalar, z.array(scalar).max(20)]),
  )
  .refine(
    (value) => Object.keys(value).length <= 20,
    'Use at most 20 detail fields.',
  )
  .refine((value) => {
    const { bytes, members } = inspectJsonValue(value);
    return bytes + 2 * members <= 8_192;
  }, 'Keep task details within 8 KB; include only the facts needed to respond.');

export const taskContextSchema = z
  .object({
    details: taskDetailsSchema.optional(),
    prefill: formValuesSchema.optional(),
  })
  .strict()
  .refine((value) => {
    const { bytes, members } = inspectJsonValue(value);
    return bytes + 2 * members <= 73_728;
  }, 'Keep task context within 72 KB; shorten the details or prefilled values.');

/** Responders finish partial selections; prefills still enforce choices and maxima. */
export function parseTaskPrefill(fields: readonly FormField[], input: unknown) {
  const files = fields.filter(
    (field) =>
      field.type === 'file' &&
      typeof input === 'object' &&
      input !== null &&
      Object.hasOwn(input, field.name),
  );
  // Only the responder can upload; a file reference is not a prefill.
  if (files.length > 0)
    throw new FormValuesInvalidError(
      files.map(({ name }) => ({
        name,
        message: 'File fields cannot be prefilled.',
      })),
    );
  return parseFormValues(
    fields.map((field) =>
      field.type === 'multi_select'
        ? { ...field, required: false, minSelections: 0 }
        : { ...field, required: false },
    ),
    input,
  );
}
export type TaskContext = z.output<typeof taskContextSchema>;
