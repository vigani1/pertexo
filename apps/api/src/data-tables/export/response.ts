import { PassThrough, Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { EXPORT_MAX_MILLIS, exportBudgetMillis } from './limits.js';
import { watchExportProgress } from './progress.js';
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
  let completion: Promise<void> | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let stopWatching: (() => void) | undefined;
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
            deadline = setTimeout(() => {
              disconnected.abort(new Error('CSV export time budget exceeded'));
            }, exportBudgetMillis(table));
            deadline.unref();
            stopWatching = watchExportProgress(reply.raw, () => {
              disconnected.abort(
                new Error('CSV export stalled for 60 seconds'),
              );
              abortResponse();
            });
            completion = finished(reply.raw, { signal, cleanup: true });
            // Observe early socket errors while the producer is still running.
            void completion.catch(() => undefined);
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
        // A clean EOF certifies that every batch and its cleanup succeeded.
        output?.end();
        await completion;
      },
      { timeoutMillis: EXPORT_MAX_MILLIS },
    );
  } catch (error) {
    if (output === undefined) throw error;
    output.destroy(
      error instanceof Error ? error : new Error('CSV export interrupted'),
    );
    // A queued stream can still become an empty 200 before headers are sent.
    abortResponse();
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    stopWatching?.();
    reply.raw.off('close', onClose);
  }
}
