// Human words for a file output: its kind from the media type, its size in
// bytes, and a short identifier for when nothing else is known yet.

const kinds: readonly (readonly [RegExp, string])[] = [
  [/^application\/json\b/u, 'JSON file'],
  [/^text\/csv\b/u, 'CSV file'],
  [/^application\/pdf\b/u, 'PDF document'],
  [/^image\//u, 'Image'],
  [/^text\/plain\b/u, 'Text file'],
  [/^text\/html\b/u, 'HTML file'],
  [/^application\/zip\b/u, 'ZIP archive'],
  [/spreadsheet|ms-excel/u, 'Spreadsheet'],
];

export function describeFileKind(mediaType: string | undefined): string {
  if (mediaType === undefined) return 'File';
  return kinds.find(([pattern]) => pattern.test(mediaType))?.[1] ?? 'File';
}

const units = ['KB', 'MB', 'GB'] as const;

/** 12 B, 3.1 KB, 4.0 MB. */
export function formatByteLength(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  let value = bytes / 1_024;
  let unit: (typeof units)[number] = 'KB';
  for (const next of units.slice(1)) {
    if (value < 1_024) break;
    value /= 1_024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}

export function shortArtifactId(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
