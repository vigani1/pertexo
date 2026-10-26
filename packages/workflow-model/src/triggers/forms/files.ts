import { z } from 'zod';
import { storageTextSchema } from '../../values/json/text.js';
import { withoutHiddenCharacters } from '../../values/text.js';

const MEBIBYTE = 1_048_576;

export const FORM_FILE_LIMITS = Object.freeze({
  maxFiles: 5,
  defaultMaxFiles: 1,
  maxBytes: 10 * MEBIBYTE,
  defaultMaxBytes: 5 * MEBIBYTE,
  filenameCharacters: 255,
  /** Uploads one response may begin, including removed and replaced files. */
  sessionUploads: 25,
  /** Leading bytes read to recognise a file's real type. */
  sniffBytes: 512,
});

type FileSignature =
  | 'pdf'
  | 'zip'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'heic'
  | 'text'
  | 'json'
  | 'xml';
type FormFileType = Readonly<{ mediaType: string; signature: FileSignature }>;

const FILE_TYPES = {
  pdf: { mediaType: 'application/pdf', signature: 'pdf' },
  docx: {
    mediaType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    signature: 'zip',
  },
  txt: { mediaType: 'text/plain', signature: 'text' },
  md: { mediaType: 'text/markdown', signature: 'text' },
  png: { mediaType: 'image/png', signature: 'png' },
  jpg: { mediaType: 'image/jpeg', signature: 'jpeg' },
  jpeg: { mediaType: 'image/jpeg', signature: 'jpeg' },
  webp: { mediaType: 'image/webp', signature: 'webp' },
  gif: { mediaType: 'image/gif', signature: 'gif' },
  heic: { mediaType: 'image/heic', signature: 'heic' },
  xlsx: {
    mediaType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    signature: 'zip',
  },
  csv: { mediaType: 'text/csv', signature: 'text' },
  json: { mediaType: 'application/json', signature: 'json' },
  xml: { mediaType: 'application/xml', signature: 'xml' },
} as const satisfies Readonly<Record<string, FormFileType>>;
export type FormFileExtension = keyof typeof FILE_TYPES;

export const FORM_FILE_GROUPS = Object.freeze({
  documents: ['pdf', 'docx', 'txt', 'md'],
  images: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'],
  spreadsheets: ['xlsx', 'csv'],
  data: ['json', 'xml'],
} as const satisfies Readonly<Record<string, readonly FormFileExtension[]>>);
export type FormFileGroup = keyof typeof FORM_FILE_GROUPS;
export const formFileGroupSchema = z.enum(
  Object.keys(FORM_FILE_GROUPS) as [FormFileGroup, ...FormFileGroup[]],
);

/** A responder's file as the run receives it: a file reference and its name. */
export const formFileValueSchema = z
  .object({
    file: z
      .object({
        kind: z.literal('artifact'),
        artifactId: z.uuid(),
        byteLength: z.number().int().min(0).max(FORM_FILE_LIMITS.maxBytes),
        mediaType: z.string().min(3).max(255),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    filename: storageTextSchema.min(1).max(FORM_FILE_LIMITS.filenameCharacters),
  })
  .strict();
export type FormFileValue = z.output<typeof formFileValueSchema>;

export type FormFileRejection = 'type' | 'size';
export class FormFileRejectedError extends Error {
  override readonly name = 'FormFileRejectedError';
  constructor(
    readonly reason: FormFileRejection,
    message: string,
  ) {
    super(message);
  }
}

export function formFileExtension(
  filename: string,
): FormFileExtension | undefined {
  const extension = filename.includes('.')
    ? filename.toLowerCase().split('.').at(-1)
    : undefined;
  return extension !== undefined && Object.hasOwn(FILE_TYPES, extension)
    ? (extension as FormFileExtension)
    : undefined;
}

/** The extension decides the stored type; the browser's guess is never trusted. */
export function formFileType(
  filename: string,
  accept: readonly FormFileGroup[],
): Readonly<{ extension: FormFileExtension; mediaType: string }> {
  const extension = formFileExtension(filename);
  const allowed: readonly FormFileExtension[] = accept.flatMap(
    (group) => FORM_FILE_GROUPS[group],
  );
  if (extension === undefined || !allowed.includes(extension))
    throw new FormFileRejectedError(
      'type',
      `This field accepts ${describeFormFileGroups(accept)}.`,
    );
  return { extension, mediaType: FILE_TYPES[extension].mediaType };
}

export function assertFormFileSize(byteLength: number, maxBytes: number) {
  if (byteLength <= maxBytes) return;
  const size = formatFormFileBytes(byteLength);
  const limit = formatFormFileBytes(maxBytes);
  throw new FormFileRejectedError(
    'size',
    // Rounded sizes can read the same; then say it is just over.
    size === limit
      ? `This file is just over the ${limit} limit.`
      : `This file is ${size}; the limit is ${limit}.`,
  );
}

/**
 * Responder names are labels only: keep the last path part, without hidden
 * characters, within the length the schemas measure (UTF-16 units) and
 * without splitting a character.
 */
export function formFilename(name: string): string {
  const base = name.split(/[\\/]/u).at(-1) ?? '';
  let kept = '';
  for (const character of withoutHiddenCharacters(base).trim()) {
    if (kept.length + character.length > FORM_FILE_LIMITS.filenameCharacters)
      break;
    kept += character;
  }
  return kept;
}

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
const startsWith = (head: Uint8Array, bytes: readonly number[], at = 0) =>
  bytes.every((byte, index) => head[at + index] === byte);
const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'mif1',
  'msf1',
]);

function textStart(head: Uint8Array): string | undefined {
  if (head.includes(0)) return undefined;
  try {
    // Streaming tolerates a character cut at the end of the sample.
    return new TextDecoder('utf-8', { fatal: true }).decode(head, {
      stream: true,
    });
  } catch {
    return undefined;
  }
}

const SIGNATURES: Readonly<
  Record<FileSignature, (head: Uint8Array) => boolean>
> = {
  pdf: (head) => startsWith(head, ascii('%PDF-')),
  zip: (head) => startsWith(head, [0x50, 0x4b, 0x03, 0x04]),
  png: (head) =>
    startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: (head) => startsWith(head, [0xff, 0xd8, 0xff]),
  gif: (head) =>
    startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a')),
  webp: (head) =>
    startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8),
  heic: (head) =>
    startsWith(head, ascii('ftyp'), 4) &&
    HEIC_BRANDS.has(String.fromCharCode(...head.subarray(8, 12))),
  text: (head) => textStart(head) !== undefined,
  json: (head) => /^\uFEFF?\s*[[{"\-0-9tfn]/u.test(textStart(head) ?? ''),
  xml: (head) => /^\uFEFF?\s*</u.test(textStart(head) ?? ''),
};

/** A magic-number check of a file's first bytes against its extension. */
export function formFileMatchesType(
  extension: FormFileExtension,
  head: Uint8Array,
): boolean {
  return SIGNATURES[FILE_TYPES[extension].signature](head);
}

const GROUP_NAMES: Readonly<Record<FormFileGroup, string>> = {
  documents: 'PDF, Word and text files',
  images: 'images',
  spreadsheets: 'spreadsheets',
  data: 'JSON and XML files',
};
export function describeFormFileGroups(
  groups: readonly FormFileGroup[],
): string {
  const names = groups.map((group) => GROUP_NAMES[group]);
  return names.length < 2
    ? (names[0] ?? 'files')
    : `${names.slice(0, -1).join(', ')} or ${names.at(-1) ?? ''}`;
}

export function formatFormFileBytes(byteLength: number): string {
  if (byteLength < 1_024) return `${String(byteLength)} B`;
  if (byteLength < MEBIBYTE)
    return `${String(Math.round(byteLength / 1_024))} KB`;
  // One decimal at most, and none when it rounds away: "2 MB", "2.4 MB".
  return `${String(Math.round((byteLength / MEBIBYTE) * 10) / 10)} MB`;
}
