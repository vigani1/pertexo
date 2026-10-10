import type { CallableType } from '@pertexo/workflow-model';

export type TypeDraft =
  | Readonly<{ type: 'null' | 'boolean' | 'number' | 'string' }>
  | Readonly<{ type: 'array'; maxItems: string; items: TypeDraft }>
  | Readonly<{
      type: 'object';
      properties: readonly Readonly<{
        id: string;
        name: string;
        required: boolean;
        valueType: TypeDraft;
      }>[];
    }>;

/** IDs belong to the open form, so renaming a property preserves its focus. */
export function editType(type: CallableType): TypeDraft {
  if (type.type === 'array')
    return {
      ...type,
      maxItems: String(type.maxItems),
      items: editType(type.items),
    };
  if (type.type === 'object')
    return {
      type: 'object',
      properties: type.properties.map((property) => ({
        ...property,
        id: crypto.randomUUID(),
        valueType: editType(property.valueType),
      })),
    };
  return type;
}

export function declaredType(draft: TypeDraft): CallableType {
  if (draft.type === 'array')
    return {
      type: 'array',
      maxItems:
        draft.maxItems.trim() === '' ? Number.NaN : Number(draft.maxItems),
      items: declaredType(draft.items),
    };
  if (draft.type === 'object')
    return {
      type: 'object',
      properties: draft.properties.map(({ name, required, valueType }) => ({
        name,
        required,
        valueType: declaredType(valueType),
      })),
    };
  return draft;
}

export function emptyType(type: TypeDraft['type']): TypeDraft {
  switch (type) {
    case 'object':
      return { type, properties: [] };
    case 'array':
      return { type, maxItems: '10', items: { type: 'string' } };
    default:
      return { type };
  }
}
