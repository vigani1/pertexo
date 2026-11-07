/** Primitive text operations never consult a user-mutated String prototype. */
export function codeTextSlice(
  value: string,
  start: number,
  end = value.length,
): string {
  let result = '';
  const stop = value.length < end ? value.length : end;
  for (let index = start; index < stop; index++) result += value[index] ?? '';
  return result;
}
export function boundedCodeText(value: string, maximum: number): string {
  return codeTextSlice(value, 0, maximum);
}
export function codeTextStartsWith(value: string, prefix: string): boolean {
  if (value.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++)
    if (value[index] !== prefix[index]) return false;
  return true;
}
