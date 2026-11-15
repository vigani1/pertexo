// Node's raw headers alternate name and value: [name, value, name, value, ...].
const RAW_HEADER_STRIDE = 2;

/**
 * Every value sent for one header, unfolded and in order. Read raw when
 * duplicates or comma-folded values must be refused rather than merged.
 */
export function rawHeaderValues(
  rawHeaders: readonly string[],
  name: string,
): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += RAW_HEADER_STRIDE)
    if (rawHeaders[index]?.toLowerCase() === name)
      values.push(rawHeaders[index + 1] ?? '');
  return values;
}
