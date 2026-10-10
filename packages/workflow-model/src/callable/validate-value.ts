import type { JsonValue } from '../json/canonical.js';
import type { CallableType } from './contract.js';

export type CallableValueIssue = Readonly<{
  path: readonly (string | number)[];
  code:
    'type_mismatch' | 'array_limit' | 'missing_property' | 'unknown_property';
}>;

/** Both arguments have passed their JSON/storage and declaration boundaries. */
export function validateCallableValue(
  type: CallableType,
  value: JsonValue,
): CallableValueIssue | undefined {
  const objects = new Map<
    CallableType,
    {
      properties: ReadonlyMap<string, CallableType>;
      required: readonly string[];
    }
  >();
  const pending: {
    type: CallableType;
    value: JsonValue;
    path: readonly (string | number)[];
  }[] = [{ type, value, path: [] }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const { type, value, path } = current;
    if (type.type === 'null') {
      if (value !== null) return { path, code: 'type_mismatch' };
    } else if (type.type === 'array') {
      if (!Array.isArray(value)) return { path, code: 'type_mismatch' };
      if (value.length > type.maxItems) return { path, code: 'array_limit' };
      for (let index = value.length - 1; index >= 0; index -= 1)
        pending.push({
          type: type.items,
          value: value[index] as JsonValue,
          path: [...path, index],
        });
    } else if (type.type === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        return { path, code: 'type_mismatch' };
      const object = value as Readonly<Record<string, JsonValue>>;
      let shape = objects.get(type);
      if (shape === undefined) {
        shape = {
          properties: new Map(
            type.properties.map(({ name, valueType }) => [name, valueType]),
          ),
          required: type.properties
            .filter(({ required }) => required)
            .map(({ name }) => name),
        };
        objects.set(type, shape);
      }
      for (const name of shape.required)
        if (!Object.hasOwn(object, name))
          return { path: [...path, name], code: 'missing_property' };
      const names = Object.keys(object);
      for (let index = names.length - 1; index >= 0; index -= 1) {
        const name = names[index];
        if (name === undefined) continue;
        const propertyType = shape.properties.get(name);
        if (propertyType === undefined)
          return { path: [...path, name], code: 'unknown_property' };
        pending.push({
          type: propertyType,
          value: object[name] as JsonValue,
          path: [...path, name],
        });
      }
    } else if (typeof value !== type.type)
      return { path, code: 'type_mismatch' };
  }
  return undefined;
}
