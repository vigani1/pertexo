// Decimal database byte counts stay exact beyond Number.MAX_SAFE_INTEGER.
const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'] as const;

/** Binary sizes using the app’s established KB/MB/GB labels. */
export function formatByteLength(bytes: number | string | bigint): string {
  const count =
    typeof bytes === 'number' ? BigInt(Math.round(bytes)) : BigInt(bytes);
  let divisor = 1n;
  let unit: (typeof units)[number] = 'B';
  for (const next of units.slice(1)) {
    if (count < divisor * 1_024n) break;
    divisor *= 1_024n;
    unit = next;
  }
  const tenths = (count * 10n + divisor / 2n) / divisor;
  const fraction = tenths % 10n;
  return `${String(tenths / 10n)}${fraction === 0n ? '' : `.${String(fraction)}`} ${unit}`;
}
