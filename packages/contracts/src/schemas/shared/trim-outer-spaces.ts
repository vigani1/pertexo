const SPACE = 0x20;

/** Remove leading and trailing U+0020 only, in linear time. */
export function trimSpaces(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === SPACE) start += 1;
  while (end > start && value.charCodeAt(end - 1) === SPACE) end -= 1;
  return value.slice(start, end);
}
