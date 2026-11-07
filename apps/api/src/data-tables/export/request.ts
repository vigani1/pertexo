import { dataTableExportQuerySchema } from '@pertexo/contracts';
import { decodeCsvDownloadRequest } from '../../platform/http/csv/csv-request.js';
import { parseRequestInput } from '../../platform/http/request-input.js';
export function decodeTableExportRequest(
  body: unknown,
  contentType: string | undefined,
) {
  return decodeCsvDownloadRequest(body, contentType, (value) =>
    parseRequestInput(dataTableExportQuerySchema, value),
  );
}
