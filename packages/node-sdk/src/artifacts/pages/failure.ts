import { NodeExecutorFailure } from '../../execution/errors.js';

const messages = {
  storage:
    'File storage is unavailable. Ask the instance owner to configure it before saving items as pages.',
  record:
    'One record cannot fit a data page (64 KB, 1,000 items or 4,000 fields/items). Flatten nested data or split wide records and files.',
  text: 'A record contains unsupported text, such as a zero character or incomplete Unicode character. Correct the file and upload it again.',
  bytes:
    'The data pages exceed 10 MB. Split the source into smaller files or request fewer records.',
  items:
    'The data pages exceed 100,000 records. Split the source into smaller files or request fewer records.',
  pages:
    'The data needs more than 256 page files. Split the source into smaller files or request fewer records.',
  descriptor:
    'The page references exceed the run-data limit. Split the source into smaller files or request fewer records.',
} as const;
export function refuseFilePages(reason: keyof typeof messages): never {
  throw new NodeExecutorFailure({
    kind: 'failed',
    errorKind: 'configuration',
    possiblyDispatched: false,
    safeErrorCode: `file.pages_${reason}`,
    errorSummary: messages[reason],
  });
}
