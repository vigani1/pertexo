import {
  request as httpRequest,
  type ServerResponse,
  type IncomingMessage,
} from 'node:http';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterEach, expect, it } from 'vitest';
import type {
  DataTablesStore,
  DataTableDefinition,
} from '@pertexo/core/data-tables';
import { sendTableExport } from '../../src/data-tables/export/response.js';
import { decodeTableExportRequest } from '../../src/data-tables/export/request.js';
import { CsrfProtectionGuard } from '../../src/workspaces/http/guards.js';
import { DoubleSubmitCsrfPolicy } from '../../src/identity/index.js';

const adapters: FastifyAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
});
const table: DataTableDefinition = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Orders',
  columns: [{ id: 'value', name: 'value', type: 'text', required: true }],
  keyColumn: null,
  hasRemovedColumns: false,
  revision: 1,
  rowCount: 1,
  storedBytes: 10,
};
async function serve(exportCsv: DataTablesStore['exportCsv']) {
  const adapter = new FastifyAdapter();
  adapters.push(adapter);
  const server = adapter.getInstance();
  server.setErrorHandler((_error, _request, reply) => {
    void reply
      .code(500)
      .type('application/problem+json')
      .send({ title: 'Export failed' });
  });
  server.post('/export', async (request, reply) => {
    await sendTableExport(
      { exportCsv },
      {
        workspaceId: '20000000-0000-4000-8000-000000000001',
        actorId: '30000000-0000-4000-8000-000000000001',
        tableId: table.id,
        query: { filters: [] },
      },
      request,
      reply,
    );
  });
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  return `${url}/export`;
}
it('streams more than 1 MB as a normal Fastify attachment', async () => {
  async function* csv() {
    yield await Promise.resolve('"value"\r\n');
    for (let i = 0; i < 32; i += 1) yield `"${'a'.repeat(65536)}"\r\n`;
  }
  const url = await serve(async ({ consume }) => {
    await consume(csv(), table);
  });
  const response = await fetch(url, { method: 'POST' });
  expect(response.headers.get('content-type')).toContain('text/csv');
  expect(response.headers.get('content-disposition')).toContain(
    'Orders-rows.csv',
  );
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const text = await response.text();
  expect(Buffer.byteLength(text)).toBeGreaterThan(1_048_576);
  expect(text.split('\r\n')).toHaveLength(34);
});
it.each(['generator', 'transaction'])(
  'aborts a partial download on %s failure',
  async (failure) => {
    const release = Promise.withResolvers<undefined>();
    async function* csv() {
      yield '"value"\r\n"first"\r\n';
      await release.promise;
      if (failure === 'generator') throw new Error('read failed');
    }
    const url = await serve(async ({ consume }) => {
      await consume(csv(), table);
      if (failure === 'transaction') throw new Error('commit failed');
    });
    const response = await fetch(url, { method: 'POST' });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('Missing response stream');
    expect((await reader.read()).done).toBe(false);
    release.resolve(undefined);
    await expect(reader.read()).rejects.toThrow();
  },
);
it('follows browser cancellation and does not produce a full buffered export', async () => {
  const finished = Promise.withResolvers<undefined>();
  let produced = 0;
  const url = await serve(async ({ consume, signal }) => {
    async function* csv() {
      for (let i = 0; i < 16384; i += 1) {
        signal?.throwIfAborted();
        produced += 1;
        yield await Promise.resolve('a'.repeat(65536));
      }
    }
    try {
      await consume(csv(), table);
    } finally {
      finished.resolve(undefined);
    }
  });
  const abort = new AbortController();
  const response = await fetch(url, { method: 'POST', signal: abort.signal });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Missing response stream');
  expect((await reader.read()).done).toBe(false);
  expect(produced).toBeLessThan(2048);
  abort.abort();
  await finished.promise;
});
it('decodes form queries once and uses the shared CSRF policy', () => {
  const csrf = new DoubleSubmitCsrfPolicy();
  const guard = new CsrfProtectionGuard(csrf);
  const token = csrf.issueToken();
  const form = new URLSearchParams({
    payload: JSON.stringify({ filters: [] }),
    csrfToken: token,
  });
  const decoded = decodeTableExportRequest(
    Buffer.from(form.toString()),
    'application/x-www-form-urlencoded',
  );
  expect(decoded.query).toEqual({ filters: [] });
  const request = { method: 'POST', cookies: { pertexo_csrf: token } };
  expect(guard.assertRequestAllowed(request, decoded.csrfToken)).toBe(true);
  expect(() => guard.assertRequestAllowed(request, 'wrong')).toThrow();
  expect(() =>
    decodeTableExportRequest(
      `${form.toString()}&csrfToken=other`,
      'application/x-www-form-urlencoded',
    ),
  ).toThrow();
  expect(() =>
    decodeTableExportRequest(
      { filters: [], sort: { column: 'value', direction: 'asc' } },
      'application/json',
    ),
  ).toThrow();
});

it('aborts if the producer fails before emitting any CSV bytes', async () => {
  async function* csv() {
    await Promise.reject(new Error('read failed before the first byte'));
    yield 'unreachable';
  }
  const url = await serve(async ({ consume }) => {
    await consume(csv(), table);
  });
  await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
});
it('keeps errors before the consumer starts as ordinary non-download responses', async () => {
  const url = await serve(() => Promise.reject(new Error('export refused')));
  const response = await fetch(url, { method: 'POST' });
  expect(response.status).toBe(500);
  expect(response.headers.get('content-disposition')).toBeNull();
  expect(response.headers.get('content-type')).toContain(
    'application/problem+json',
  );
  await response.text();
});

it('aborts a real backpressured HTTP download after no socket progress, without buffering the file', async () => {
  const closed = Promise.withResolvers<undefined>();
  let produced = 0;
  const url = await serve(async ({ consume, signal }) => {
    async function* csv() {
      for (let i = 0; i < 4096; i++) {
        signal?.throwIfAborted();
        produced++;
        yield await Promise.resolve('x'.repeat(65536));
      }
    }
    try {
      await consume(csv(), { ...table, storedBytes: 50 * 1_048_576 });
    } finally {
      closed.resolve(undefined);
    }
  });
  let response: ServerResponse | undefined;
  adapters
    .at(-1)
    ?.getInstance()
    .server.on('request', (_request, reply) => {
      response = reply;
    });
  const pending = Promise.withResolvers<IncomingMessage>();
  const request = httpRequest(url, { method: 'POST' }, pending.resolve);
  request.on('error', pending.reject);
  request.end();
  const download = await pending.promise;
  download.on('error', () => undefined);
  try {
    // No client reads. The server must reach actual socket backpressure first.
    await expect.poll(() => response?.writableNeedDrain).toBe(true);
    await closed.promise;
    expect(response?.destroyed).toBe(true);
    expect(produced).toBeLessThan(4096);
  } finally {
    download.destroy();
    request.destroy();
  }
}, 75_000);
