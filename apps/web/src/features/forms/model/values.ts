import type { FormField, FormValues } from '@pertexo/workflow-model';
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
  if (type === 'multi_select' || type === 'file') return [];
  return '';
}

/** Captured prefills hold only typed answers; files are never prefilled. */
export function draftFromValues(values: FormValues | undefined): FormDraft {
  return Object.fromEntries(
    Object.entries(values ?? {}).flatMap(
      ([name, value]): [string, FormDraftValue][] => {
        if (typeof value === 'number') return [[name, String(value)]];
        if (typeof value === 'string' || typeof value === 'boolean')
          return [[name, value]];
        const choices = value.filter((item) => typeof item === 'string');
        return choices.length === value.length ? [[name, choices]] : [];
      },
    ),
  );
}
