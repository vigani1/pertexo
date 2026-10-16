import { storageTextSchema } from '../json/text.js';
import { z } from 'zod';
import { inspectJsonValue } from '../json/canonical.js';
import { FORM_LIMITS, type FormField } from './fields.js';

const selectionSchema = z
  .array(storageTextSchema)
  .max(FORM_LIMITS.options)
  .refine(
    (values) => new Set(values).size === values.length,
    'Choose each option once.',
  );
export const formValuesSchema = z.record(
  z.string(),
  z.union([storageTextSchema, z.number(), z.boolean(), selectionSchema]),
);
export type FormValues = Readonly<z.output<typeof formValuesSchema>>;
export class FormValuesInvalidError extends Error {
  override readonly name = 'FormValuesInvalidError';
  constructor(
    readonly fields: readonly Readonly<{ name: string; message: string }>[],
  ) {
    super('Check the form fields and try again.');
  }
}
function valueSchema(field: FormField): z.ZodType {
  switch (field.type) {
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'email':
      return storageTextSchema.pipe(z.email().max(FORM_LIMITS.textCharacters));
    case 'date':
      return z.iso.date();
    case 'multi_select':
      return selectionSchema
        .min(1)
        .refine(
          (values) => values.every((value) => field.options.includes(value)),
          'Choose available options.',
        );
    case 'select':
      return z
        .string()
        .refine(
          (value) => field.options.includes(value),
          'Choose an available option.',
        );
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
                (field.type !== 'multi_select' &&
                  typeof value === 'string' &&
                  value.trim() === '') ||
                (field.type === 'multi_select' &&
                  Array.isArray(value) &&
                  value.length === 0)
                  ? undefined
                  : value,
              schema.optional(),
            ),
      ];
    }),
  );
  const result = z.object(shape).strict().safeParse(input);
  if (!result.success)
    throw new FormValuesInvalidError(
      result.error.issues.slice(0, FORM_LIMITS.fields).map((issue) => ({
        name: typeof issue.path[0] === 'string' ? issue.path[0] : '',
        message:
          issue.code === 'unrecognized_keys'
            ? 'Remove fields that are not in this form.'
            : 'Enter a valid value for this field.',
      })),
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
