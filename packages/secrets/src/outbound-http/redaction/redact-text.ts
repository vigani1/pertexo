import { prepareResponseRedactor } from './response-redactor.js';

export function redactText(
  value: string,
  sensitiveValues: readonly string[],
): string {
  return prepareResponseRedactor(sensitiveValues).text(value);
}
