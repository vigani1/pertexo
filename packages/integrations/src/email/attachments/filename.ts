import {
  utf8ByteLength,
  withoutHiddenCharacters,
} from '@pertexo/workflow-model';
import { EMAIL_SEND_NOTIFICATION_LIMITS } from '../validation.js';

// File references carry no name (ADR 075), so an unnamed attachment is named
// after its stored media type.
const EXTENSIONS: Readonly<Record<string, string>> = {
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/xml': 'xml',
  'application/zip': 'zip',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'text/calendar': 'ics',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'text/xml': 'xml',
};

/** `attachment.csv`, or `attachment-2.csv` when the email has several files. */
export function defaultAttachmentFilename(
  mediaType: string,
  position: Readonly<{ index: number; count: number }>,
): string {
  const essence = mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const extension = EXTENSIONS[essence];
  const stem =
    position.count > 1
      ? `attachment-${String(position.index + 1)}`
      : 'attachment';
  return extension === undefined ? stem : `${stem}.${extension}`;
}

/**
 * The name recipients see: no path separators, control or format characters,
 * at most 255 UTF-8 bytes with the extension kept. Undefined when nothing
 * usable is left.
 */
export function sanitizeAttachmentFilename(value: string): string | undefined {
  const cleaned = withoutHiddenCharacters(value.replace(/[\\/]/gu, '')).trim();
  if (cleaned === '' || /^\.+$/u.test(cleaned)) return undefined;
  const limit = EMAIL_SEND_NOTIFICATION_LIMITS.maxAttachmentFilenameBytes;
  if (utf8ByteLength(cleaned) <= limit) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension =
    dot > 0 && utf8ByteLength(cleaned.slice(dot)) <= 32
      ? cleaned.slice(dot)
      : '';
  const stem = Array.from(cleaned.slice(0, cleaned.length - extension.length));
  let bytes = utf8ByteLength(extension);
  let kept = '';
  for (const character of stem) {
    const size = utf8ByteLength(character);
    if (bytes + size > limit) break;
    bytes += size;
    kept += character;
  }
  return `${kept.trimEnd()}${extension}`;
}
