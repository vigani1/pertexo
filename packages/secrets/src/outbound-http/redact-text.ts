import { sensitiveRepresentations } from './sensitive-representations.js';

export function redactText(
  value: string,
  sensitiveValues: readonly string[],
): string {
  let result = value;
  for (const sensitive of sensitiveRepresentations(sensitiveValues))
    result = result.replaceAll(sensitive, '[Redacted]');
  return result;
}
