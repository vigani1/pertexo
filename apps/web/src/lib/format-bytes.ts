// Shared byte-size text for files, payloads and uploads.

const units = ['KB', 'MB', 'GB'] as const;

/** 12 B, 3.1 KB, 4 MB: a whole size drops its ".0". */
export function formatByteLength(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  let value = bytes / 1_024;
  let unit: (typeof units)[number] = 'KB';
  for (const next of units.slice(1)) {
    if (value < 1_024) break;
    value /= 1_024;
    unit = next;
  }
  const rounded = value.toFixed(1);
  return `${rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded} ${unit}`;
}
