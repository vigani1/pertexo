import { FORM_FILE_LIMITS, type FormField } from '@pertexo/workflow-model';

/** Changing a field's type keeps its identity, wording and compatible setup. */
export function fieldOfType(
  current: FormField,
  type: FormField['type'],
): FormField {
  const base = {
    id: current.id,
    name: current.name,
    label: current.label,
    help: current.help,
    required: current.required,
  };
  switch (type) {
    case 'select':
    case 'multi_select':
      return {
        ...base,
        type,
        options:
          current.type === 'select' || current.type === 'multi_select'
            ? current.options
            : ['Option 1'],
      };
    case 'file':
      return {
        ...base,
        type,
        accept: ['documents'],
        maxFiles: FORM_FILE_LIMITS.defaultMaxFiles,
        maxBytes: FORM_FILE_LIMITS.defaultMaxBytes,
      };
    case 'boolean':
    case 'text':
    case 'textarea':
    case 'email':
    case 'number':
    case 'date':
      return { ...base, type };
  }
}
