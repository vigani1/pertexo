import type { FormField } from '@pertexo/workflow-model';
/** Controls retain editable text; only complete finite numbers become JSON numbers. */
export function valuesFromDraft(
  fields: readonly FormField[],
  draft: Readonly<Record<string, string | boolean>>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    fields.map((field): [string, string | number | boolean] => {
      const raw = draft[field.name] ?? (field.type === 'boolean' ? false : '');
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
