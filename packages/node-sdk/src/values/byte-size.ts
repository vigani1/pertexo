// Sizes use binary units with one word each: 1 KB is 1,024 bytes, 1 MB is 1,024 KB.
const KILOBYTE = 1_024;
const MEGABYTE = KILOBYTE * KILOBYTE;
const UNITS = Object.freeze([
  { bytes: MEGABYTE, name: 'MB' },
  { bytes: KILOBYTE, name: 'KB' },
]);
// One decimal place: 1.5 MB.
const TENTHS = 10;

/**
 * A byte size as people read it in messages: "512 B", "64 KB", "1.5 MB".
 * It never rounds: a size that isn't a whole or one-decimal unit is written in
 * exact bytes ("1,600 B"), so a limit always reads as the limit it is.
 */
export function formatByteSize(bytes: number): string {
  for (const unit of UNITS) {
    const tenths = (bytes * TENTHS) / unit.bytes;
    if (bytes >= unit.bytes && Number.isInteger(tenths))
      return `${formatCount(tenths / TENTHS)} ${unit.name}`;
  }
  return `${formatCount(bytes)} B`;
}

/** A count as people read it in messages: "10,000". */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
