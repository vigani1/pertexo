export function thresholdError({
  value,
  optional = false,
}: Readonly<{ value: string; optional?: boolean | undefined }>):
  string | undefined {
  if (optional && value.trim() === '') return undefined;
  return /^\d+$/u.test(value) && Number(value) >= 3 && Number(value) <= 100
    ? undefined
    : 'Enter a whole number from 3 to 100.';
}
