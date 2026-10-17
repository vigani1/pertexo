import { dataTableExportQuerySchema } from '@pertexo/contracts';
import { decodeCsvDownloadRequest } from '../../platform/http/csv/request.js';
export function decodeTableExportRequest(
  body: unknown,
  contentType: string | undefined,
) {
  return decodeCsvDownloadRequest(body, contentType, (value) =>
    dataTableExportQuerySchema.parse(value),
  );
}
