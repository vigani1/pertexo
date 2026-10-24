import type { FormField } from '@pertexo/workflow-model';
export type FormDraftValue = string | boolean | readonly string[];
export type FormDraft = Readonly<Record<string, FormDraftValue>>;
/** Controls retain editable text; only complete finite numbers become JSON numbers. */
export function valuesFromDraft(
  fields: readonly FormField[],
  draft: FormDraft,
): Readonly<Record<string, FormDraftValue | number>> {
  return Object.fromEntries(
    fields.map((field): [string, FormDraftValue | number] => {
      const raw = draft[field.name] ?? emptyFieldValue(field.type);
      if (
        field.type === 'number' &&
        typeof raw === 'string' &&
        raw.trim() !== ''
      ) {
        const number = Number(raw);
        return [field.name, Number.isFinite(number) ? number : raw];
      }
      return [field.name, raw];
    }),
  );
}

function emptyFieldValue(type: FormField['type']): FormDraftValue {
  if (type === 'boolean') return false;
  if (type === 'multi_select') return [];
  return '';
}
