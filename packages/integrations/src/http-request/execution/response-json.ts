import type { JsonValue } from '@pertexo/node-sdk/server';

/** Parsing can recover a credential from JSON escapes the byte stream did not recognize. */
export function redactResponseJson(
  value: JsonValue,
  redact: (text: string) => string,
): JsonValue {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value))
    return (value as readonly JsonValue[]).map((item) =>
      redactResponseJson(item, redact),
    );
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries<JsonValue>(value).map(([key, item]) => [
        redact(key),
        redactResponseJson(item, redact),
      ]),
    );
  return value;
}
