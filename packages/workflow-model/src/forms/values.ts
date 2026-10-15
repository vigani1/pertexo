import { z } from 'zod';
import { inspectJsonValue } from '../json/canonical.js';
import { FORM_LIMITS, formTextSchema, type FormField } from './fields.js';

export type FormValues = Readonly<Record<string, string | number | boolean>>;
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
      return formTextSchema.pipe(z.email().max(FORM_LIMITS.textCharacters));
    case 'date':
      return z.iso.date();
    case 'select':
      return z
        .string()
        .refine(
          (value) => field.options.includes(value),
          'Choose an available option.',
        );
    default:
      return formTextSchema
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
                typeof value === 'string' && value.trim() === ''
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
    values: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
    submittedBy: z.uuid().nullable(),
    submittedAt: z.iso.datetime(),
  })
  .strict();
export type FormSubmission = z.output<typeof formSubmissionSchema>;
