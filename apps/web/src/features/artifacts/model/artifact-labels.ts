// Human words for a file output: its kind from the media type and a short
// identifier for when nothing else is known yet. Sizes use lib/format-bytes.

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

export function shortArtifactId(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
