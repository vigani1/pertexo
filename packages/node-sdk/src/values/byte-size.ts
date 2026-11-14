// Sizes use binary units with one word each: 1 KB is 1,024 bytes, 1 MB is 1,024 KB.
const KILOBYTE = 1_024;
const MEGABYTE = KILOBYTE * KILOBYTE;
const MEGABYTE_DECIMALS = 10;

/**
 * A byte size as people read it in messages: "512 B", "64 KB", "2.4 MB".
 * Kilobytes round to whole numbers; megabytes keep one decimal unless it is 0.
 */
export function formatByteSize(bytes: number): string {
  if (bytes < KILOBYTE) return `${String(bytes)} B`;
  if (bytes < MEGABYTE) return `${String(Math.round(bytes / KILOBYTE))} KB`;
  const megabytes =
    Math.round((bytes / MEGABYTE) * MEGABYTE_DECIMALS) / MEGABYTE_DECIMALS;
  return `${String(megabytes)} MB`;
}

/** A count as people read it in messages: "10,000". */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
