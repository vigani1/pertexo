import { z } from 'zod';

export const CALLABLE_TYPE_LIMITS_V1 = Object.freeze({
  depth: 8,
  descriptors: 256,
  properties: 128,
  maxItems: 1_000,
});

export type CallableTypeDescriptorV1 =
  | Readonly<{ type: 'string' | 'number' | 'integer' | 'boolean' | 'null' }>
  | Readonly<{
      type: 'array';
      items: CallableTypeDescriptorV1;
      maxItems: number;
    }>
  | CallableObjectTypeDescriptorV1;

export interface CallableObjectTypeDescriptorV1 {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, CallableTypeDescriptorV1>>;
  readonly required: readonly string[];
}

/** Documentation projection only; bounded admission below remains authoritative. */
export const callableObjectTypeDescriptorStructuralSchemaV1: z.ZodType<CallableObjectTypeDescriptorV1> =
  z.lazy(() =>
    z
      .object({
        type: z.literal('object'),
        properties: z.record(
          z
            .string()
            .regex(
              /^(?!(?:__proto__|prototype|constructor)$)[A-Za-z_][A-Za-z0-9_]{0,63}$/u,
            ),
          callableTypeDescriptorStructuralSchemaV1,
        ),
        required: z
          .array(z.string().min(1).max(64))
          .max(CALLABLE_TYPE_LIMITS_V1.properties),
      })
      .strict(),
  );

export const callableTypeDescriptorStructuralSchemaV1: z.ZodType<CallableTypeDescriptorV1> =
  z.lazy(() =>
    z.union([
      z
        .object({
          type: z.enum(['string', 'number', 'integer', 'boolean', 'null']),
        })
        .strict(),
      z
        .object({
          type: z.literal('array'),
          items: callableTypeDescriptorStructuralSchemaV1,
          maxItems: z
            .number()
            .int()
            .min(1)
            .max(CALLABLE_TYPE_LIMITS_V1.maxItems),
        })
        .strict(),
      callableObjectTypeDescriptorStructuralSchemaV1,
    ]),
  );

const propertyName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const forbiddenNames = new Set(['__proto__', 'prototype', 'constructor']);

/** Read only plain, enumerable own data; never invoke an input accessor. */
function record(value: unknown, maximum: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid descriptor');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    throw new Error('invalid descriptor');
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximum) throw new Error('invalid descriptor');
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error('invalid descriptor');
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (field === undefined || !('value' in field) || !field.enumerable)
      throw new Error('invalid descriptor');
    result[key] = field.value;
  }
  return result;
}

function requiredNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error('invalid descriptor');
  const lengthField = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthField === undefined ||
    !('value' in lengthField) ||
    !Number.isSafeInteger(lengthField.value) ||
    lengthField.value < 0 ||
    lengthField.value > CALLABLE_TYPE_LIMITS_V1.properties
  )
    throw new Error('invalid descriptor');
  const length = lengthField.value as number;
  if (Reflect.ownKeys(value).length !== length + 1)
    throw new Error('invalid descriptor');
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      field === undefined ||
      !('value' in field) ||
      !field.enumerable ||
      typeof field.value !== 'string' ||
      !propertyName.test(field.value) ||
      forbiddenNames.has(field.value) ||
      result.includes(field.value)
    )
      throw new Error('invalid descriptor');
    result.push(field.value);
  }
  return Object.freeze(result);
}

function parseDescriptor(input: unknown): CallableTypeDescriptorV1 | undefined {
  let descriptors = 0;
  const seen = new Set<object>();
  function visit(value: unknown, depth: number): CallableTypeDescriptorV1 {
    descriptors += 1;
    if (
      depth > CALLABLE_TYPE_LIMITS_V1.depth ||
      descriptors > CALLABLE_TYPE_LIMITS_V1.descriptors
    )
      throw new Error('invalid descriptor');
    const fields = record(value, 3);
    if (seen.has(value as object)) throw new Error('invalid descriptor');
    seen.add(value as object);
    switch (fields.type) {
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        if (Object.keys(fields).length !== 1)
          throw new Error('invalid descriptor');
        return Object.freeze({ type: fields.type });
      case 'array': {
        if (
          Object.keys(fields).length !== 3 ||
          !Number.isInteger(fields.maxItems) ||
          (fields.maxItems as number) < 1 ||
          (fields.maxItems as number) > CALLABLE_TYPE_LIMITS_V1.maxItems
        )
          throw new Error('invalid descriptor');
        return Object.freeze({
          type: 'array',
          items: visit(fields.items, depth + 1),
          maxItems: fields.maxItems as number,
        });
      }
      case 'object': {
        if (Object.keys(fields).length !== 3)
          throw new Error('invalid descriptor');
        const source = record(
          fields.properties,
          CALLABLE_TYPE_LIMITS_V1.properties,
        );
        const properties: Record<string, CallableTypeDescriptorV1> =
          Object.create(null) as Record<string, CallableTypeDescriptorV1>;
        for (const key of Object.keys(source)) {
          if (!propertyName.test(key) || forbiddenNames.has(key))
            throw new Error('invalid descriptor');
          properties[key] = visit(source[key], depth + 1);
        }
        const required = requiredNames(fields.required);
        if (required.some((key) => !Object.hasOwn(properties, key)))
          throw new Error('invalid descriptor');
        return Object.freeze({
          type: 'object',
          properties: Object.freeze(properties),
          required,
        });
      }
      default:
        throw new Error('invalid descriptor');
    }
  }
  try {
    return visit(input, 1);
  } catch {
    return undefined;
  }
}

/** Bounded admission precedes recursion; errors contain no hostile input. */
export const callableTypeDescriptorSchemaV1 = z
  .unknown()
  .transform((input, ctx) => {
    const descriptor = parseDescriptor(input);
    if (descriptor === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid bounded callable type descriptor',
      });
      return z.NEVER;
    }
    return descriptor;
  });

export const callableObjectTypeDescriptorSchemaV1 =
  callableTypeDescriptorSchemaV1.transform((descriptor, ctx) => {
    if (descriptor.type !== 'object') {
      ctx.addIssue({
        code: 'custom',
        message: 'Callable root must be a closed object',
      });
      return z.NEVER;
    }
    return descriptor;
  });

/** Documentation projection only; the descriptor remains validation authority. */
export function callableTypeJsonSchemaV1(
  input: CallableTypeDescriptorV1,
): Record<string, unknown> {
  const descriptor = callableTypeDescriptorSchemaV1.parse(input);
  function project(type: CallableTypeDescriptorV1): Record<string, unknown> {
    if (type.type === 'array')
      return {
        type: 'array',
        items: project(type.items),
        maxItems: type.maxItems,
      };
    if (type.type === 'object')
      return {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(type.properties).map(([key, child]) => [
            key,
            project(child),
          ]),
        ),
        required: [...type.required],
        additionalProperties: false,
      };
    return { type: type.type };
  }
  return project(descriptor);
}
