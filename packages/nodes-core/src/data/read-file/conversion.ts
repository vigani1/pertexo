const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
export function convertCsvValue(
  value: string,
  enabled: boolean,
): string | number | boolean {
  if (!enabled) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (!JSON_NUMBER.test(value)) return value;
  const number = Number(value);
  return Number.isFinite(number) &&
    (!Number.isInteger(number) || Number.isSafeInteger(number))
    ? number
    : value;
}
