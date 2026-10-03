import {
  callableTypeDescriptorSchemaV1,
  type CallableTypeDescriptorV1,
} from './callable-type-contract.js';

// Match the independent node JSON value policy, not descriptor cardinalities.
export const CALLABLE_VALUE_JSON_LIMITS_V1 = Object.freeze({
  bytes: 1_048_576,
  depth: 64,
  members: 10_000,
});

export type CallableValueIssueCodeV1 =
  | 'invalid_descriptor'
  | 'invalid_json'
  | 'json_limit'
  | 'type_mismatch'
  | 'required_property'
  | 'undeclared_property'
  | 'array_limit';
export type CallableValueValidationV1 =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      issue: Readonly<{ code: CallableValueIssueCodeV1; path: string }>;
    }>;

function failure(
  code: CallableValueIssueCodeV1,
  path: string,
): CallableValueValidationV1 {
  return { ok: false, issue: { code, path } };
}

function matchesPrimitive(
  type: CallableTypeDescriptorV1,
  input: unknown,
): boolean {
  switch (type.type) {
    case 'null':
      return input === null;
    case 'integer':
      return typeof input === 'number' && Number.isInteger(input);
    case 'number':
      return typeof input === 'number';
    case 'string':
      return typeof input === 'string';
    case 'boolean':
      return typeof input === 'boolean';
    default:
      return false;
  }
}

/** One bounded issue; paths contain only admitted schema names/array indices. */
export function validateCallableValueV1(
  descriptorInput: unknown,
  value: unknown,
): CallableValueValidationV1 {
  const parsed = callableTypeDescriptorSchemaV1.safeParse(descriptorInput);
  if (!parsed.success) return failure('invalid_descriptor', '$');
  const limits = CALLABLE_VALUE_JSON_LIMITS_V1;
  let bytes = 0;
  let members = 0;
  const seen = new Set<object>();
  function addBytes(count: number): boolean {
    bytes += count;
    return bytes <= limits.bytes;
  }
  function visitArray(
    type: Extract<CallableTypeDescriptorV1, { type: 'array' }>,
    input: object,
    path: string,
    depth: number,
  ): CallableValueValidationV1 {
    const lengthField = Object.getOwnPropertyDescriptor(input, 'length');
    if (
      lengthField === undefined ||
      !('value' in lengthField) ||
      !Number.isSafeInteger(lengthField.value) ||
      lengthField.value < 0
    )
      return failure('invalid_json', path);
    const length = lengthField.value as number;
    if (length > type.maxItems) return failure('array_limit', path);
    if (Reflect.ownKeys(input).length !== length + 1)
      return failure('invalid_json', path);
    members += length;
    if (members > limits.members || !addBytes(2 + Math.max(0, length - 1)))
      return failure('json_limit', path);
    for (let index = 0; index < length; index += 1) {
      const field = Object.getOwnPropertyDescriptor(input, String(index));
      if (field === undefined || !('value' in field) || !field.enumerable)
        return failure('invalid_json', path);
      const result = visit(
        type.items,
        field.value,
        `${path}[${String(index)}]`,
        depth + 1,
      );
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  function visit(
    type: CallableTypeDescriptorV1,
    input: unknown,
    path: string,
    depth: number,
  ): CallableValueValidationV1 {
    if (depth > limits.depth) return failure('json_limit', path);
    if (typeof input === 'string' && input.length > limits.bytes)
      return failure('json_limit', path);
    if (
      input === null ||
      typeof input === 'string' ||
      typeof input === 'boolean' ||
      typeof input === 'number'
    ) {
      if (typeof input === 'number' && !Number.isFinite(input))
        return failure('invalid_json', path);
      if (!addBytes(new TextEncoder().encode(JSON.stringify(input)).byteLength))
        return failure('json_limit', path);
      return matchesPrimitive(type, input)
        ? { ok: true }
        : failure('type_mismatch', path);
    }
    if (typeof input !== 'object') return failure('invalid_json', path);
    if (seen.has(input)) return failure('invalid_json', path);
    seen.add(input);
    const array = Array.isArray(input);
    if ((!array && type.type !== 'object') || (array && type.type !== 'array'))
      return failure('type_mismatch', path);
    const prototype: unknown = Object.getPrototypeOf(input);
    if (!array && prototype !== Object.prototype && prototype !== null)
      return failure('invalid_json', path);
    if (type.type === 'array' && array) {
      return visitArray(type, input, path, depth);
    }
    if (type.type !== 'object') return failure('type_mismatch', path);
    const keys = Reflect.ownKeys(input);
    members += keys.length;
    if (members > limits.members || !addBytes(2 + Math.max(0, keys.length - 1)))
      return failure('json_limit', path);
    for (const key of keys) {
      if (typeof key !== 'string') return failure('invalid_json', path);
      if (!Object.hasOwn(type.properties, key))
        return failure('undeclared_property', path);
      const field = Object.getOwnPropertyDescriptor(input, key);
      if (field === undefined || !('value' in field) || !field.enumerable)
        return failure('invalid_json', path);
      if (
        !addBytes(new TextEncoder().encode(JSON.stringify(key)).byteLength + 1)
      )
        return failure('json_limit', path);
      const child = type.properties[key];
      if (child === undefined) return failure('invalid_descriptor', path);
      const result = visit(child, field.value, `${path}.${key}`, depth + 1);
      if (!result.ok) return result;
    }
    for (const key of type.required)
      if (!Object.hasOwn(input, key))
        return failure('required_property', `${path}.${key}`);
    return { ok: true };
  }
  try {
    return visit(parsed.data, value, '$', 1);
  } catch {
    return failure('invalid_json', '$');
  }
}
