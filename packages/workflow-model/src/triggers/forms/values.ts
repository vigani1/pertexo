import { storageTextSchema } from '../../values/json/text.js';
import { z } from 'zod';
import { inspectJsonValue } from '../../values/json/canonical.js';
import { FORM_LIMITS, type FormField } from './fields.js';
import {
  FORM_FILE_LIMITS,
  formFileValueSchema,
  type FormFileValue,
} from './files.js';

const selectionSchema = z
  .array(storageTextSchema)
  .max(FORM_LIMITS.options)
  .refine(
    (values) => new Set(values).size === values.length,
    'Choose each option once.',
  );
export const formValuesSchema = z.record(
  z.string(),
  z.union([
    storageTextSchema,
    z.number(),
    z.boolean(),
    selectionSchema,
    z.array(formFileValueSchema).max(FORM_FILE_LIMITS.maxFiles),
  ]),
);
export type FormValues = Readonly<z.output<typeof formValuesSchema>>;
export class FormValuesInvalidError extends Error {
  override readonly name = 'FormValuesInvalidError';
  constructor(
    readonly fields: readonly Readonly<{ name: string; message: string }>[],
  ) {
    super(
      fields.length === 1 && fields[0]?.name === ''
        ? fields[0].message
        : 'Check the form fields and try again.',
    );
  }
}
function valueSchema(field: FormField): z.ZodType {
  switch (field.type) {
    case 'number':
      return z.number();
    case 'boolean':
      return (field.mustBeTicked ?? false) ? z.literal(true) : z.boolean();
    case 'email':
      return storageTextSchema.pipe(z.email().max(FORM_LIMITS.textCharacters));
    case 'date':
      return z.iso.date();
    case 'multi_select':
      return selectionSchema
        .min(Math.max(1, field.minSelections ?? 1))
        .max(field.maxSelections ?? field.options.length)
        .refine(
          (values) => values.every((value) => field.options.includes(value)),
          'Choose available options.',
        );
    case 'file':
      // Responses name uploads; the server swaps them for file references.
      return z
        .array(z.uuid().transform((id) => id.toLowerCase()))
        .min(1)
        .max(field.maxFiles)
        .refine(
          (values) => new Set(values).size === values.length,
          'Attach each file once.',
        );
    case 'select':
      return z
        .string()
        .refine(
          (value) => field.options.includes(value),
          'Choose an available option.',
        );
    case 'text':
    case 'textarea':
    default:
      return storageTextSchema
        .max(FORM_LIMITS.textCharacters)
        .refine((value) => value.trim().length > 0, 'Enter a value.');
  }
}
/** The captured published fields are trusted; submitted values cross the boundary here. */
export function parseFormValues(
  fields: readonly FormField[],
  input: unknown,
): FormValues {
  try {
    if (inspectJsonValue(input).bytes > FORM_LIMITS.submissionBytes)
      throw new FormValuesInvalidError([
        { name: '', message: 'Keep the form response within 64 KB.' },
      ]);
  } catch (error) {
    if (error instanceof FormValuesInvalidError) throw error;
    throw new FormValuesInvalidError([
      { name: '', message: 'Send ordinary JSON field values.' },
    ]);
  }
  const shape = Object.fromEntries(
    fields.map((field) => {
      const schema = valueSchema(field);
      return [
        field.name,
        field.required
          ? schema
          : z.preprocess(
              (value) =>
                (!isListField(field) &&
                  typeof value === 'string' &&
                  value.trim() === '') ||
                (isListField(field) &&
                  Array.isArray(value) &&
                  value.length === 0)
                  ? undefined
                  : value,
              schema.optional(),
            ),
      ];
    }),
  );
  // Zod reads declared properties directly; absent JSON fields must not
  // resolve through Object.prototype.
  const submitted =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? Object.assign(Object.create(null) as Record<string, unknown>, input)
      : input;
  const result = z.object(shape).strict().safeParse(submitted);
  if (!result.success)
    throw new FormValuesInvalidError(
      result.error.issues.slice(0, FORM_LIMITS.fields).map((issue) => {
        const field = fields.find((field) => field.name === issue.path[0]);
        return {
          name: typeof issue.path[0] === 'string' ? issue.path[0] : '',
          message: validationIssueMessage(field, issue, input),
        };
      }),
    );
  return Object.fromEntries(
    Object.entries(result.data).filter(([, value]) => value !== undefined),
  ) as FormValues;
}
export const formSubmissionSchema = z
  .object({
    values: formValuesSchema,
    submittedBy: z.uuid().nullable(),
    submittedAt: z.iso.datetime(),
  })
  .strict();
export type FormSubmission = z.output<typeof formSubmissionSchema>;

function isListField(field: FormField): boolean {
  return field.type === 'multi_select' || field.type === 'file';
}

function fileMessage(
  field: Extract<FormField, { type: 'file' }>,
  value: unknown,
): string {
  if (!Array.isArray(value) || value.length === 0)
    return field.maxFiles === 1
      ? 'Attach a file.'
      : 'Attach at least one file.';
  if (value.length > field.maxFiles)
    return `Attach up to ${String(field.maxFiles)} ${field.maxFiles === 1 ? 'file' : 'files'}.`;
  return 'Upload each file again; one of them was not received.';
}

function selectionMessage(
  field: Extract<FormField, { type: 'multi_select' }>,
): string {
  const min = Math.max(1, field.minSelections ?? 1);
  const max = field.maxSelections ?? field.options.length;
  return `Choose ${min === max ? String(min) : `${String(min)}–${String(max)}`} different available options.${field.required ? '' : ' You may leave this field empty.'}`;
}

function fieldMessage(
  field: FormField,
  issue: z.core.$ZodIssue,
  input: unknown,
): string {
  const value = submittedFieldValue(field, input);
  if (field.type === 'multi_select') return selectionMessage(field);
  if (field.type === 'file') return fileMessage(field, value);
  if (
    field.type === 'boolean' &&
    (field.mustBeTicked ?? false) &&
    value === false
  )
    return 'Tick this box to continue.';
  if (value === undefined || value === null || value === '')
    return 'This field is required.';
  if (issue.code === 'too_big' && typeof value === 'string')
    return `Keep this to ${String(FORM_LIMITS.textCharacters)} characters.`;
  if (issue.code === 'custom') return issue.message;
  switch (field.type) {
    case 'number':
      return 'Enter a number.';
    case 'email':
      return 'Enter an email address.';
    case 'date':
      return 'Enter a date like 2026-10-19.';
    case 'boolean':
      return 'Choose yes or no.';
    case 'select':
      return 'Choose an available option.';
    case 'text':
    case 'textarea':
    default:
      return 'Enter text.';
  }
}

function validationIssueMessage(
  field: FormField | undefined,
  issue: z.core.$ZodIssue,
  input: unknown,
): string {
  if (issue.code === 'unrecognized_keys')
    return 'Remove fields that are not in this form.';
  if (field === undefined) return 'Enter a valid value for this field.';
  return fieldMessage(field, issue, input);
}

function submittedFieldValue(field: FormField, input: unknown): unknown {
  return typeof input === 'object' &&
    input !== null &&
    Object.hasOwn(input, field.name)
    ? (input as Record<string, unknown>)[field.name]
    : undefined;
}

/** Upload IDs a parsed response names, by field; the server resolves them. */
export function formFileUploads(
  fields: readonly FormField[],
  values: FormValues,
): readonly Readonly<{ field: FormField; uploadIds: readonly string[] }>[] {
  return fields.flatMap((field) => {
    const value = values[field.name];
    return field.type === 'file' && Array.isArray(value)
      ? [{ field, uploadIds: value.filter((id) => typeof id === 'string') }]
      : [];
  });
}

/** Swap upload IDs for the files they name; unknown IDs are field errors. */
export function attachFormFiles(
  fields: readonly FormField[],
  values: FormValues,
  files: ReadonlyMap<string, FormFileValue>,
): FormValues {
  const missing: { name: string; message: string }[] = [];
  const attached = { ...values };
  for (const { field, uploadIds } of formFileUploads(fields, values)) {
    const found = uploadIds.map((id) => files.get(`${field.id}:${id}`));
    if (found.every((file) => file !== undefined)) attached[field.name] = found;
    else
      missing.push({
        name: field.name,
        message:
          'A file is no longer available. Remove it and upload it again.',
      });
  }
  if (missing.length > 0) throw new FormValuesInvalidError(missing);
  return attached;
}
