import { ARTIFACT_INPUT_MAX_BYTES, FILE_PAGE_LIMITS } from '@pertexo/node-sdk';
import { HTTP_REQUEST_LIMITS } from '@pertexo/integrations';
import { formatByteLength } from '@/lib/format/bytes';

const count = new Intl.NumberFormat('en-US');

/** Platform file limits as people read them, from the constants the checks use. */
export const FILE_LIMIT_COPY = Object.freeze({
  inline: formatByteLength(ARTIFACT_INPUT_MAX_BYTES),
  file: formatByteLength(FILE_PAGE_LIMITS.fileBytes),
  records: count.format(FILE_PAGE_LIMITS.totalItems),
  pageBytes: formatByteLength(FILE_PAGE_LIMITS.bytes),
  pageRecords: count.format(FILE_PAGE_LIMITS.items),
  pages: String(FILE_PAGE_LIMITS.pages),
  request: formatByteLength(HTTP_REQUEST_LIMITS.maxRequestBodyBytes),
});
