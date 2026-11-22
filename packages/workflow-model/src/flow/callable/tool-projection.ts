import type { CallableType } from './callable-types.js';
import type { JsonValue } from '../../values/json/canonical.js';
import { utf8ByteLength } from '../../values/text.js';

const CALLABLE_INPUT_SCHEMA_MAX_BYTES = 64 * 1024;

export function callableObjectInputSchema(input: CallableType) {
  if (input.type !== 'object') return undefined;
  const schema = objectSchema(input);
  if (utf8ByteLength(JSON.stringify(schema)) <= CALLABLE_INPUT_SCHEMA_MAX_BYTES)
    return schema;
  return undefined;
}

function jsonSchema(type: CallableType): Record<string, JsonValue> {
  switch (type.type) {
    case 'object':
      return objectSchema(type);
    case 'array':
      return {
        type: 'array',
        maxItems: type.maxItems,
        items: jsonSchema(type.items),
      };
    case 'null':
    case 'boolean':
    case 'number':
    case 'string':
      return { type: type.type };
  }
}

function objectSchema(type: Extract<CallableType, { type: 'object' }>) {
  return {
    type: 'object',
    properties: Object.fromEntries(
      type.properties.map(({ name, valueType }) => [
        name,
        jsonSchema(valueType),
      ]),
    ),
    required: type.properties
      .filter(({ required }) => required)
      .map(({ name }) => name),
    additionalProperties: false,
  };
}
