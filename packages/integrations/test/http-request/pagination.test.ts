import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeCatalog } from '@pertexo/node-sdk';
import {
  createNodeRegistry,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import {
  HTTP_REQUEST_MANIFEST,
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  httpRequestConfigSchema,
} from '../../src/index.js';
import {
  createHttpRequestExecutorRegistration,
  createNodeSecureHttpClient,
  parseAllowedPrivateNetworks,
} from '../../src/server.js';
import { nextLink } from '../../src/http-request/pagination/link.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(closers.splice(0).map((close) => close()));
});
async function server(
  handler: (
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ) => void,
) {
  const app = createServer((request, response) => {
    handler(new URL(request.url ?? '/', 'http://localhost'), request, response);
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const address = app.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing test address');
  closers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        app.closeAllConnections();
        app.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  );
  return `http://127.0.0.1:${String(address.port)}`;
}
function json(response: ServerResponse, value: unknown) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}
function setup(
  url: string,
  pagination: Record<string, unknown>,
  options: Readonly<{
    signal?: AbortSignal;
    deadlineAt?: Date;
    credentials?: boolean;
    config?: Record<string, unknown>;
  }> = {},
) {
  const connectionId = randomUUID();
  const secret = new TextEncoder().encode(
    JSON.stringify({
      type: 'http_headers',
      headers: { authorization: 'Bearer test-page-secret' },
    }),
  );
  const beforeDispatch = vi.fn<NodeExecutionRuntime['beforeDispatch']>(() =>
    Promise.resolve(),
  );
  const assertCurrent = vi.fn(() => Promise.resolve());
  const write = vi.fn(() =>
    Promise.reject(new Error('Paging must never write an artifact')),
  );
  const runtime: NodeExecutionRuntime = {
    workspaceId: randomUUID(),
    runId: randomUUID(),
    nodeRunId: randomUUID(),
    attemptId: randomUUID(),
    nodeId: 'http',
    invocationKey: 'http',
    attemptNumber: 1,
    sideEffectClass: 'unsafe',
    beforeDispatch,
    artifacts: { write },
    ...(options.deadlineAt === undefined
      ? {}
      : { deadlineAt: options.deadlineAt }),
    ...(options.credentials === true
      ? {
          connections: {
            assertCurrent,
            resolve: () =>
              Promise.resolve({
                connectionId,
                providerKey: 'http',
                authType: 'http_headers',
                secretVersionId: randomUUID(),
                secret,
              }),
          },
        }
      : {}),
  };
  const config = {
    method: 'GET',
    url,
    headers: {},
    timeoutMillis: 1000,
    maxRedirects: 3,
    maxResponseBytes: 1_048_576,
    inlineResponseBytes: 262_144,
    pagination: {
      itemsPath: '$.data',
      maxPages: 10,
      delayMillis: 0,
      ...pagination,
    },
    ...options.config,
  };
  const registry = createNodeRegistry({
    catalog: createNodeCatalog({
      definitions: [HTTP_REQUEST_MANIFEST],
      executors: [
        {
          executor: HTTP_REQUEST_MANIFEST.executor,
          abiVersion: 2,
          definitions: [HTTP_REQUEST_MANIFEST.definition],
          policyReferences: HTTP_REQUEST_MANIFEST.policyReferences,
        },
      ],
      policies: HTTP_REQUEST_MANIFEST.policyReferences,
    }),
    definitions: [HTTP_REQUEST_DEFINITION_REGISTRATION],
    executors: [
      createHttpRequestExecutorRegistration({
        httpClient: createNodeSecureHttpClient({
          allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
        }),
      }),
    ],
  });
  return {
    beforeDispatch,
    assertCurrent,
    write,
    secret,
    run: () =>
      registry.execute({
        definition: HTTP_REQUEST_MANIFEST.definition,
        executor: HTTP_REQUEST_MANIFEST.executor,
        config,
        input: {},
        connectionRefs:
          options.credentials === true ? { http_headers: connectionId } : {},
        runtime,
        signal: options.signal ?? new AbortController().signal,
      }),
  };
}

describe('HTTP pagination through the real secure transport and registry', () => {
  it.each(['next_link', 'link_header', 'cursor', 'page', 'offset'])(
    'fetches three %s pages in order and marks dispatch once',
    async (mode) => {
      const received: string[] = [];
      const root = await server((url, request, response) => {
        received.push(request.headers.authorization ?? '');
        const page =
          mode === 'offset'
            ? Number(url.searchParams.get('offset') ?? 0) / 2 + 1
            : Number(
                url.searchParams.get(mode === 'cursor' ? 'cursor' : 'page') ??
                  1,
              );
        if (mode === 'link_header' && page < 3)
          response.setHeader(
            'link',
            `</items?page=${String(page + 1)}>; title="a,b"; rel="next prev"`,
          );
        const data =
          (mode === 'page' || mode === 'offset') && page === 4 ? [] : [page];
        json(response, {
          data,
          ...(page < 3
            ? {
                next:
                  mode === 'cursor'
                    ? String(page + 1)
                    : `?page=${String(page + 1)}`,
              }
            : {}),
        });
      });
      const pagination =
        mode === 'link_header'
          ? { mode: 'next_link', source: { kind: 'link_header' } }
          : mode === 'next_link'
            ? { mode, source: { kind: 'body', path: '$.next' } }
            : mode === 'cursor'
              ? { mode, cursorPath: '$.next', parameter: 'cursor' }
              : mode === 'offset'
                ? { mode, parameter: 'offset', step: 2 }
                : { mode, parameter: 'page' };
      const execution = setup(`${root}/items`, pagination, {
        credentials: true,
      });
      const result = await execution.run();
      expect(result.output).toMatchObject({
        items: [1, 2, 3],
        pageCount: mode === 'page' || mode === 'offset' ? 4 : 3,
        complete: true,
        status: 200,
        finalOrigin: root,
      });
      expect(
        received.every((value) => value === 'Bearer test-page-secret'),
      ).toBe(true);
      expect(execution.assertCurrent).toHaveBeenCalledTimes(received.length);
      expect(execution.beforeDispatch).toHaveBeenCalledOnce();
      expect(execution.write).not.toHaveBeenCalled();
      expect(execution.secret.every((byte) => byte === 0)).toBe(true);
    },
  );
  it.each([undefined, null, '', '?page=1'])(
    'ends on a missing, null, empty or repeated link: %s',
    async (next) => {
      let count = 0;
      const root = await server((_url, _request, response) => {
        count += 1;
        json(response, { data: [1], ...(next === undefined ? {} : { next }) });
      });
      const result = await setup(`${root}/items?page=1`, {
        mode: 'next_link',
        source: { kind: 'body', path: '$.next' },
      }).run();
      expect(result.output).toMatchObject({
        items: [1],
        pageCount: 1,
        complete: true,
      });
      expect(count).toBe(1);
    },
  );
  it.each([null, '', 'same'])(
    'ends on an empty or repeated cursor: %s',
    async (next) => {
      let count = 0;
      const root = await server((_url, _request, response) => {
        count += 1;
        json(response, { data: [1], next });
      });
      const result = await setup(`${root}/items?cursor=same`, {
        mode: 'cursor',
        cursorPath: '$.next',
        parameter: 'cursor',
      }).run();
      expect(result.output).toMatchObject({ pageCount: 1, complete: true });
      expect(count).toBe(1);
    },
  );
  it('ends at an empty item list even if another link is present', async () => {
    const root = await server((_url, _request, response) => {
      json(response, { data: [], next: '?page=2' });
    });
    expect(
      (
        await setup(root, {
          mode: 'next_link',
          source: { kind: 'body', path: '$.next' },
        }).run()
      ).output,
    ).toMatchObject({ items: [], pageCount: 1, complete: true });
  });
  it('reports Max pages without probing beyond it', async () => {
    let requests = 0;
    const root = await server((_url, _request, response) => {
      requests += 1;
      json(response, { data: [requests] });
    });
    expect(
      (
        await setup(root, {
          mode: 'page',
          parameter: 'page',
          maxPages: 2,
        }).run()
      ).output,
    ).toMatchObject({ items: [1, 2], pageCount: 2, complete: false });
    expect(requests).toBe(2);
  });
  it('resolves a relative link against the redirected page URL', async () => {
    const paths: string[] = [];
    const root = await server((url, _request, response) => {
      paths.push(url.pathname);
      if (url.pathname === '/start') {
        response.writeHead(302, { location: '/nested/page' });
        response.end();
      } else
        json(response, {
          data: [url.pathname],
          ...(url.pathname.endsWith('/page') ? { next: 'next' } : {}),
        });
    });
    expect(
      (
        await setup(`${root}/start`, {
          mode: 'next_link',
          source: { kind: 'body', path: '$.next' },
        }).run()
      ).output,
    ).toMatchObject({
      items: ['/nested/page', '/nested/next'],
      complete: true,
    });
    expect(paths).toEqual(['/start', '/nested/page', '/nested/next']);
  });
  it.each(['link', 'redirect'])(
    'never sends credentials to another origin from a %s',
    async (kind) => {
      let foreign = 0;
      const other = await server((_url, _request, response) => {
        foreign += 1;
        json(response, { data: [] });
      });
      const root = await server((_url, _request, response) => {
        if (kind === 'redirect') {
          response.writeHead(302, { location: other });
          response.end();
        } else json(response, { data: [1], next: other });
      });
      await expect(
        setup(
          root,
          { mode: 'next_link', source: { kind: 'body', path: '$.next' } },
          { credentials: true },
        ).run(),
      ).rejects.toMatchObject({
        code: 'http.pagination_origin_changed',
        page: 1,
      });
      expect(foreign).toBe(0);
    },
  );
  it.each(['text', 'malformed', 'missing_list', 'large'])(
    'gives a safe page diagnostic for %s',
    async (kind) => {
      const root = await server((_url, _request, response) => {
        response.setHeader(
          'content-type',
          kind === 'text' ? 'text/plain' : 'application/json',
        );
        response.end(
          kind === 'malformed'
            ? '{bad'
            : kind === 'missing_list'
              ? '{}'
              : JSON.stringify({
                  data: ['x'.repeat(kind === 'large' ? 2000 : 1)],
                }),
        );
      });
      const execution = setup(
        root,
        { mode: 'page', parameter: 'page' },
        { config: { inlineResponseBytes: 1024 } },
      );
      await expect(execution.run()).rejects.toMatchObject({
        code: 'http.pagination_invalid_page',
        page: 1,
      });
      expect(execution.write).not.toHaveBeenCalled();
    },
  );
  it('fails rather than returning a partial result beyond the 1 MiB envelope', async () => {
    const root = await server((_url, _request, response) => {
      json(response, { data: ['x'.repeat(200_000)] });
    });
    await expect(
      setup(root, { mode: 'page', parameter: 'page' }).run(),
    ).rejects.toMatchObject({
      code: 'http.pagination_too_large',
      page: 6,
    });
  });
  it('fails within the existing member envelope too', async () => {
    const root = await server((_url, _request, response) => {
      json(response, { data: Array.from({ length: 5000 }, () => 1) });
    });
    await expect(
      setup(root, { mode: 'page', parameter: 'page' }).run(),
    ).rejects.toMatchObject({ code: 'http.pagination_too_large', page: 2 });
  });
  it('classifies a 429 on page two before parsing its non-JSON body, with a bounded persisted retry hint', async () => {
    const root = await server((url, _request, response) => {
      if (url.searchParams.get('page') === '2') {
        response.writeHead(429, {
          'retry-after': '30',
          'content-type': 'text/plain',
        });
        response.end('do not leak provider details');
      } else json(response, { data: [1] });
    });
    await expect(
      setup(root, { mode: 'page', parameter: 'page' }).run(),
    ).rejects.toMatchObject({
      kind: 'retry',
      errorKind: 'rate_limit',
      possiblyDispatched: false,
      minimumRetryDelayMillis: 30_000,
    });
  });
  it('refuses a paging budget that cannot fit before dispatch', async () => {
    const root = await server((_url, _request, response) => {
      json(response, { data: [] });
    });
    const execution = setup(
      root,
      { mode: 'page', parameter: 'page' },
      { deadlineAt: new Date(Date.now() + 1000) },
    );
    await expect(execution.run()).rejects.toMatchObject({
      code: 'http.pagination_budget_exceeded',
    });
    expect(execution.beforeDispatch).not.toHaveBeenCalled();
  });
  it('cancels during the inter-page delay without dispatching the next page', async () => {
    const controller = new AbortController();
    let requests = 0;
    const root = await server((_url, _request, response) => {
      requests += 1;
      json(response, { data: [1] });
    });
    const running = setup(
      root,
      { mode: 'page', parameter: 'page', delayMillis: 10_000 },
      { signal: controller.signal },
    ).run();
    await vi.waitFor(() => {
      expect(requests).toBe(1);
    });
    controller.abort();
    await expect(running).rejects.toMatchObject({ kind: 'canceled' });
    expect(requests).toBe(1);
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])(
    'refuses pagination for %s',
    (method) => {
      expect(
        httpRequestConfigSchema.safeParse({
          method,
          url: 'https://example.test',
          headers: {},
          timeoutMillis: 100,
          maxRedirects: 0,
          maxResponseBytes: 100,
          inlineResponseBytes: 100,
          pagination: { mode: 'page', parameter: 'page', itemsPath: '$' },
        }).success,
      ).toBe(false);
    },
  );
});

describe('bounded Link next relation', () => {
  it('respects quoted commas, escapes and relative URI commas', () => {
    expect(
      nextLink(
        '</items?q=a,b>; title="an escaped \\" quote, here"; rel="prev next", </last>; rel=last',
        1,
      ),
    ).toBe('/items?q=a,b');
  });
  it('ignores links with a different context and non-next relations', () => {
    expect(
      nextLink('</next>; rel=next; anchor="/other", </last>; rel=last', 1),
    ).toBeUndefined();
  });
  it('does not choose an arbitrary target when next links conflict', () => {
    expect(() => nextLink('</a>; rel=next, </b>; rel=next', 1)).toThrow();
  });
});
