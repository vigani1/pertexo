/**
 * Whether a parsed object has exactly the allowed fields, each a plain
 * enumerable value. Every engine boundary uses this one rule and raises its
 * own error code when it fails.
 */
export function hasExactFields(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const isPlainField = (key: string): boolean => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && 'value' in descriptor;
  };
  return (
    Object.getOwnPropertyNames(value).every((key) => allowed.has(key)) &&
    required.every(isPlainField) &&
    optional.every((key) => !Object.hasOwn(value, key) || isPlainField(key))
  );
}
