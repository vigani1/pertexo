import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DataTablesStore } from '@pertexo/core/data-tables';
import { sendCsvDownload } from '../../platform/http/csv/response.js';
type ExportInput = Omit<
  Parameters<DataTablesStore['exportCsv']>[0],
  'consume' | 'signal'
>;
export function sendTableExport(
  store: Pick<DataTablesStore, 'exportCsv'>,
  input: ExportInput,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  return sendCsvDownload(
    (signal, consume) =>
      store.exportCsv({
        ...input,
        signal,
        consume: (csv, table) =>
          consume(csv, {
            filename: `${table.name}-rows.csv`,
            storedBytes: table.storedBytes,
          }),
      }),
    request,
    reply,
  );
}
