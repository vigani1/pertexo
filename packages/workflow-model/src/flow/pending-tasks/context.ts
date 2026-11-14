import { z } from 'zod';
import {
  PENDING_TASK_LIMITS,
  storedTaskBytes,
  taskKilobytes,
} from './audience.js';
import { storageTextSchema } from '../../values/json/text.js';
import {
  parseFormValues,
  formValuesSchema,
} from '../../triggers/forms/values.js';
import { FormValuesInvalidError } from '../../triggers/forms/forms.errors.js';
import type { FormField } from '../../triggers/forms/fields.js';

const scalar = z.union([storageTextSchema, z.number(), z.boolean(), z.null()]);
export const taskDetailsSchema = z
  .record(
    storageTextSchema
      .min(1)
      .max(PENDING_TASK_LIMITS.detailNameCharacters)
      .refine((value) => value.trim().length > 0, 'Give each detail a name.'),
    z.union([scalar, z.array(scalar).max(PENDING_TASK_LIMITS.detailListItems)]),
  )
  .refine(
    (value) => Object.keys(value).length <= PENDING_TASK_LIMITS.detailFields,
    `Use at most ${String(PENDING_TASK_LIMITS.detailFields)} detail fields.`,
  )
  .refine(
    (value) => storedTaskBytes(value) <= PENDING_TASK_LIMITS.detailsBytes,
    `Keep task details within ${taskKilobytes(PENDING_TASK_LIMITS.detailsBytes)}; include only the facts needed to respond.`,
  );

export const taskContextSchema = z
  .object({
    details: taskDetailsSchema.optional(),
    prefill: formValuesSchema.optional(),
  })
  .strict()
  .refine(
    (value) => storedTaskBytes(value) <= PENDING_TASK_LIMITS.contextBytes,
    `Keep task context within ${taskKilobytes(PENDING_TASK_LIMITS.contextBytes)}; shorten the details or prefilled values.`,
  );

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
