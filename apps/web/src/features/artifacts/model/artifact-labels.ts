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

export type FileFamily = 'data' | 'document' | 'image' | 'archive' | 'other';

const tags: readonly (readonly [RegExp, string, FileFamily])[] = [
  [/^text\/csv\b/u, 'CSV', 'data'],
  [/^application\/json\b/u, 'JSON', 'data'],
  [/spreadsheetml|ms-excel/u, 'XLS', 'data'],
  [/^(application|text)\/xml\b/u, 'XML', 'data'],
  [/^application\/pdf\b/u, 'PDF', 'document'],
  [/wordprocessingml|msword/u, 'DOC', 'document'],
  [/^text\/html\b/u, 'HTML', 'document'],
  [/^text\/markdown\b/u, 'MD', 'document'],
  [/^text\/calendar\b/u, 'ICS', 'document'],
  [/^text\//u, 'TXT', 'document'],
  [/^image\//u, 'IMG', 'image'],
  [/zip|gzip|x-tar/u, 'ZIP', 'archive'],
];

/** A file's type as a short tag ("CSV") and the family its glyph is tinted by. */
export function fileTypeTag(
  mediaType: string | undefined,
  name?: string,
): Readonly<{ tag: string; family: FileFamily }> {
  const match =
    mediaType === undefined
      ? undefined
      : tags.find(([pattern]) => pattern.test(mediaType.toLowerCase()));
  if (match !== undefined) return { tag: match[1], family: match[2] };
  const extension = name?.match(/\.([A-Za-z0-9]{1,4})$/u)?.[1];
  return {
    tag: extension === undefined ? 'FILE' : extension.toUpperCase(),
    family: 'other',
  };
}

export function shortArtifactId(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
