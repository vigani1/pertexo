import { NodeExecutorFailure } from '../../execution/node-execution.errors.js';
import { FILE_PAGE_LIMITS } from '../page-limits.js';

const count = (value: number) => value.toLocaleString('en-US');
const MEBIBYTE = 1_048_576;
const size = (bytes: number) =>
  bytes < MEBIBYTE
    ? `${String(bytes / 1_024)} KB`
    : `${String(bytes / MEBIBYTE)} MB`;

export const FILE_PAGES_ERROR_CODE = Object.freeze({
  storage: 'file.pages_storage',
  record: 'file.pages_record',
  text: 'file.pages_text',
  bytes: 'file.pages_bytes',
  items: 'file.pages_items',
  pages: 'file.pages_pages',
  descriptor: 'file.pages_descriptor',
} as const);

const messages = {
  storage:
    'File storage is unavailable. Ask the instance owner to configure it before saving items as pages.',
  record: `One record cannot fit a data page (${size(FILE_PAGE_LIMITS.bytes)}, ${count(FILE_PAGE_LIMITS.items)} items or ${count(FILE_PAGE_LIMITS.members)} fields/items). Flatten nested data or split wide records and files.`,
  text: 'A record contains unsupported text, such as a zero character or incomplete Unicode character. Correct the file and upload it again.',
  bytes: `The data pages exceed ${size(FILE_PAGE_LIMITS.totalBytes)}. Split the source into smaller files or request fewer records.`,
  items: `The data pages exceed ${count(FILE_PAGE_LIMITS.totalItems)} records. Split the source into smaller files or request fewer records.`,
  pages: `The data needs more than ${count(FILE_PAGE_LIMITS.pages)} page files. Split the source into smaller files or request fewer records.`,
  descriptor:
    'The page references exceed the run-data limit. Split the source into smaller files or request fewer records.',
} as const;
export function refuseFilePages(reason: keyof typeof messages): never {
  throw new NodeExecutorFailure({
    kind: 'failed',
    errorKind: 'configuration',
    possiblyDispatched: false,
    safeErrorCode: FILE_PAGES_ERROR_CODE[reason],
    errorSummary: messages[reason],
  });
}
