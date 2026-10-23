import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { filePageBundleSchema } from '@pertexo/node-sdk';
import type { NodeArtifactRuntime } from '@pertexo/node-sdk/server';

import { server, json, setup } from '../../support/pagination.js';
describe('explicit HTTP result pages', () => {
  function storage() {
    const pages = new Map<string, Buffer>();
    const write = vi.fn<NodeArtifactRuntime['write']>(async (input) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks),
        artifactId = randomUUID();
      pages.set(artifactId, bytes);
      return {
        artifactId,
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mediaType: input.mediaType,
      };
    });
    return { pages, write };
  }
  it('keeps over 1 MB ordered records in bounded files, with redaction and distinct fetch counts', async () => {
    const files = storage();
    let requests = 0;
    const root = await server((url, _request, response) => {
      requests++;
      const page = Number(url.searchParams.get('page') ?? 1);
      json(response, {
        data:
          page > 12
            ? []
            : Array.from({ length: 900 }, (_, i) => ({
                id: (page - 1) * 900 + i,
                text: 'x'.repeat(100),
                secret: 'Bearer test-page-secret',
              })),
      });
    });
    const result = await setup(
      root,
      { mode: 'page', parameter: 'page', maxPages: 20, outputMode: 'pages' },
      { artifacts: { write: files.write }, credentials: true },
    ).run();
    if (result.kind !== 'succeeded') throw Error('Paged request failed');
    const raw = result.output as {
      pages: unknown;
      itemCount: unknown;
      pageCount: unknown;
      fetchedPageCount: number;
      complete: boolean;
    };
    const bundle = filePageBundleSchema.parse({
      pages: raw.pages,
      itemCount: raw.itemCount,
      pageCount: raw.pageCount,
    });
    expect(bundle.itemCount).toBe(10800);
    expect(raw.fetchedPageCount).toBe(13);
    expect(requests).toBe(13);
    expect(raw.complete).toBe(true);
    expect(bundle.pageCount).toBeGreaterThan(13);
    const rows: unknown[] = bundle.pages.flatMap(
      (page) =>
        JSON.parse(
          files.pages.get(page.artifactId)?.toString() ?? 'null',
        ) as unknown[],
    );
    expect(rows[0]).toMatchObject({ id: 0 });
    expect(rows.at(-1)).toMatchObject({ id: 10799 });
    expect(
      [...files.pages.values()].reduce((n, bytes) => n + bytes.length, 0),
    ).toBeGreaterThan(1048576);
    for (const bytes of files.pages.values()) {
      expect(bytes.length).toBeLessThanOrEqual(65536);
      expect(bytes.includes(Buffer.from('test-page-secret'))).toBe(false);
    }
  });
  it('returns no successful descriptor after a late provider failure, and retries still start from page one', async () => {
    const files = storage();
    const received: number[] = [];
    const root = await server((url, _request, response) => {
      const page = Number(url.searchParams.get('page') ?? 1);
      received.push(page);
      if (page === 3) {
        response.statusCode = 503;
        json(response, { code: 'unavailable' });
        return;
      }
      json(response, {
        data: Array.from({ length: 1000 }, (_, id) => ({
          id,
          text: 'x'.repeat(80),
        })),
      });
    });
    const run = setup(
      root,
      { mode: 'page', parameter: 'page', outputMode: 'pages' },
      { artifacts: { write: files.write } },
    );
    await expect(run.run()).rejects.toMatchObject({
      kind: 'retry',
      possiblyDispatched: false,
    });
    expect(files.write).toHaveBeenCalled();
    expect(received).toEqual([1, 2, 3]);
    await expect(run.run()).rejects.toMatchObject({ kind: 'retry' });
    expect(received).toEqual([1, 2, 3, 1, 2, 3]);
  });
  it('does not turn storage failure into a successful partial result or an unknown GET outcome', async () => {
    const root = await server((_url, _request, response) => {
      json(response, { data: [1], next: null });
    });
    const run = setup(
      root,
      {
        mode: 'next_link',
        source: { kind: 'body', path: '$.next' },
        outputMode: 'pages',
      },
      {
        artifacts: {
          write: () => Promise.reject(new Error('private storage detail')),
        },
      },
    );
    await expect(run.run()).rejects.toMatchObject({
      kind: 'failed',
      possiblyDispatched: false,
    });
  });
});
