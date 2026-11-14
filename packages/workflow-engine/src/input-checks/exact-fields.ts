/**
 * Whether a parsed object has exactly the allowed fields. Every engine boundary uses
 * this one rule and raises its own error code when it fails.
 */
export function hasExactFields(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}
