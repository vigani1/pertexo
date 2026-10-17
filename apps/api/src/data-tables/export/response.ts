import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DataTablesStore } from '@pertexo/database/data-tables';
import { withRequestOperationSignal } from '../../platform/http/index.js';

type ExportInput = Omit<
  Parameters<DataTablesStore['exportCsv']>[0],
  'consume' | 'signal'
>;

export async function sendTableExport(
  store: Pick<DataTablesStore, 'exportCsv'>,
  input: ExportInput,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const disconnected = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableFinished) disconnected.abort();
  };
  reply.raw.once('close', onClose);
  let output: PassThrough | undefined;
  const abortResponse = () => {
    reply.raw.destroy();
  };
  try {
    await withRequestOperationSignal(
      request,
      async (operation) => {
        const signal = AbortSignal.any([operation, disconnected.signal]);
        await store.exportCsv({
          ...input,
          signal,
          consume: async (csv, table) => {
            output = new PassThrough({ highWaterMark: 64 * 1024 });
            output.once('error', abortResponse);
            reply.header('Content-Type', 'text/csv; charset=utf-8');
            reply.header(
              'Content-Disposition',
              `attachment; filename="${table.name}-rows.csv"`,
            );
            reply.header('Cache-Control', 'private, no-store');
            reply.header('X-Content-Type-Options', 'nosniff');
            void reply.send(output);
            await pipeline(
              Readable.from(csv, {
                objectMode: false,
                highWaterMark: 64 * 1024,
              }),
              output,
              { signal, end: false },
            );
          },
        });
        // A clean EOF certifies that the transaction and its cleanup succeeded too.
        output?.end();
      },
      { timeoutMillis: 30 * 60 * 1000 },
    );
  } catch (error) {
    if (output === undefined) throw error;
    output.destroy(
      error instanceof Error ? error : new Error('CSV export interrupted'),
    );
    // A queued stream can still become an empty 200 before headers are sent.
    abortResponse();
  } finally {
    reply.raw.off('close', onClose);
  }
}
