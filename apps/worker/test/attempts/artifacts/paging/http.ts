import { createHash, randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import type { createPagedFileSource } from '../pages-source.fixture.js';
import {
  createNodeSecureHttpClient,
  parseAllowedPrivateNetworks,
  createHttpRequestExecutorRegistration,
} from '@pertexo/integrations/server';
import type { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { filePageBundleSchema } from '@pertexo/node-sdk';
import type {
  NodeArtifactReference,
  NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import { headerConnection } from '../../../support/attempts/header-connection.js';

type FileStepExecutor = (
  key: string,
  config: unknown,
  input: unknown,
) => ReturnType<ReturnType<typeof createPlatformNodeRegistry>['execute']>;

export async function assertPagedHttpSource(
  input: Readonly<{
    pagedSource: Awaited<ReturnType<typeof createPagedFileSource>>;
    runtime: NodeExecutionRuntime;
    signal: AbortSignal;
    execute: FileStepExecutor;
  }>,
) {
  const { pagedSource, runtime, signal, execute } = input;
  const httpConnectionId = randomUUID();
  const httpOutput = await createHttpRequestExecutorRegistration({
    httpClient: createNodeSecureHttpClient({
      allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
    }),
  }).execute({
    config: {
      method: 'GET',
      url: pagedSource.url,
      headers: {},
      timeoutMillis: 1000,
      maxRedirects: 0,
      maxResponseBytes: 262144,
      inlineResponseBytes: 262144,
      pagination: {
        mode: 'next_link',
        source: { kind: 'body', path: '$.next' },
        itemsPath: '$.data',
        maxPages: 10,
        delayMillis: 0,
        outputMode: 'pages',
      },
    },
    input: {},
    connectionRefs: { http_headers: httpConnectionId },
    signal,
    runtime: {
      ...runtime,
      sideEffectClass: 'unsafe',
      connections: headerConnection(httpConnectionId, randomUUID(), {
        authorization: pagedSource.authorization,
      }),
    },
  });
  const output = httpOutput as {
    pages: unknown;
    itemCount: number;
    pageCount: number;
    fetchedPageCount: number;
  };
  const httpPages = filePageBundleSchema.parse({
    pages: output.pages,
    itemCount: output.itemCount,
    pageCount: output.pageCount,
  });
  expect(httpPages.itemCount).toBe(7200);
  expect(output.fetchedPageCount).toBe(8);
  expect(pagedSource.received).toHaveLength(8);
  expect(
    pagedSource.received.every((value) => value === pagedSource.authorization),
  ).toBe(true);
  const assembled = await execute(
    'core.create_file',
    { format: 'json', inputMode: 'pages' },
    { pages: httpPages.pages },
  );
  if (assembled.kind !== 'succeeded')
    throw new Error('HTTP page assembly failed');
  const assembledFile = (assembled.output as { file: NodeArtifactReference })
    .file;
  const expectedHttp = Buffer.from(JSON.stringify(pagedSource.rows));
  expect(expectedHttp.byteLength).toBeGreaterThan(1048576);
  expect(assembledFile.byteLength).toBe(expectedHttp.length);
  expect(assembledFile.sha256).toBe(
    createHash('sha256').update(expectedHttp).digest('hex'),
  );
}
