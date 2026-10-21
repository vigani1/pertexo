export function redactText(
  value: string,
  sensitiveValues: readonly string[],
): string {
  let result = value;
  for (const sensitive of sensitiveValues)
    result = result.replaceAll(sensitive, '[Redacted]');
  return result;
}
