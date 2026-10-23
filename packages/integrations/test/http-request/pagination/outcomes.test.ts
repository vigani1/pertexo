import { describe, expect, it, vi } from 'vitest';

import { httpRequestConfigSchema } from '../../../src/index.js';

import { server, json, setup } from '../../support/pagination.js';
describe('HTTP pagination through the real secure transport and registry', () => {
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
  it('honours Retry-After for a single request too', async () => {
    const root = await server((_url, _request, response) => {
      response.writeHead(429, { 'retry-after': '30' });
      response.end('rate limited');
    });
    await expect(
      setup(root, {}, { singleRequest: true }).run(),
    ).rejects.toMatchObject({ kind: 'retry', minimumRetryDelayMillis: 30_000 });
  });
  it('reports unexpected paging errors as definite without disclosing them', async () => {
    await expect(
      setup(
        'https://example.test',
        { mode: 'page', parameter: 'page' },
        { unexpectedTransportFailure: true },
      ).run(),
    ).rejects.toMatchObject({
      kind: 'failed',
      errorKind: 'internal',
      possiblyDispatched: false,
    });
  });
  it.each(['next_link', 'link_header', 'cursor'])(
    'does not inspect unused %s navigation at Max pages',
    async (mode) => {
      const root = await server((_url, _request, response) => {
        response.setHeader('link', '</a>; rel=next, </b>; rel=next');
        json(response, { data: [1], next: { invalid: true } });
      });
      const pagination =
        mode === 'cursor'
          ? { mode, parameter: 'cursor', cursorPath: '$.next' }
          : {
              mode: 'next_link',
              source:
                mode === 'link_header'
                  ? { kind: 'link_header' }
                  : { kind: 'body', path: '$.next' },
            };
      expect(
        (await setup(root, { ...pagination, maxPages: 1 }).run()).output,
      ).toMatchObject({ items: [1], pageCount: 1, complete: false });
    },
  );
  it.each(['body', 'link_header', 'cursor'] as const)(
    'reports final-page completion from %s continuation presence without following it',
    async (mode) => {
      for (const present of [false, true]) {
        let requests = 0;
        const root = await server((_url, _request, response) => {
          requests += 1;
          if (mode === 'link_header' && present)
            response.setHeader(
              'link',
              '<https://another-origin.example.test/next>; rel=next',
            );
          json(response, {
            data: [1],
            ...(present
              ? { next: 'https://another-origin.example.test/next' }
              : {}),
          });
        });
        const pagination =
          mode === 'cursor'
            ? { mode, parameter: 'cursor', cursorPath: '$.next' }
            : {
                mode: 'next_link',
                source:
                  mode === 'body'
                    ? { kind: 'body', path: '$.next' }
                    : { kind: 'link_header' },
              };
        expect(
          (await setup(root, { ...pagination, maxPages: 1 }).run()).output,
        ).toMatchObject({ items: [1], pageCount: 1, complete: !present });
        expect(requests).toBe(1);
      }
    },
  );
  it.each(['page', 'offset', 'cursor'])(
    'preserves unrelated query encoding in %s mode',
    async (mode) => {
      const received: string[] = [];
      const root = await server((_url, request, response) => {
        received.push(request.url ?? '');
        json(response, {
          data: [received.length],
          next: received.length === 1 ? 'a b~' : null,
        });
      });
      const pagination =
        mode === 'cursor'
          ? { mode, parameter: 'position', cursorPath: '$.next' }
          : {
              mode,
              parameter: 'position',
              ...(mode === 'offset' ? { step: 10 } : {}),
            };
      await setup(
        `${root}/?q=a%20b~&escaped=%2f&position=old&repeated=1&repeated=2`,
        { ...pagination, maxPages: 2 },
      ).run();
      expect(received).toHaveLength(2);
      expect(received[0]).toBe(
        `/?q=a%20b~&escaped=%2f&position=${mode === 'cursor' ? 'old' : mode === 'page' ? '1' : '0'}&repeated=1&repeated=2`,
      );
      expect(received[1]).toBe(
        `/?q=a%20b~&escaped=%2f&position=${mode === 'cursor' ? 'a+b%7E' : mode === 'page' ? '2' : '10'}&repeated=1&repeated=2`,
      );
    },
  );
  it('refuses a huge item array with a safe page diagnostic', async () => {
    const root = await server((_url, _request, response) => {
      json(response, { data: Array.from({ length: 131_000 }, () => 0) });
    });
    await expect(
      setup(root, { mode: 'page', parameter: 'page' }, {}).run(),
    ).rejects.toMatchObject({
      kind: 'failed',
      code: 'http.pagination_invalid_page',
    });
  });
  it('accounts for escaped multibyte items and nested members across pages', async () => {
    const value = { text: '\u0000"é🙂', nested: [1, { ok: true }] };
    const root = await server((_url, _request, response) => {
      json(response, { data: [value] });
    });
    const output = (
      await setup(root, {
        mode: 'page',
        parameter: 'page',
        maxPages: 100,
      }).run()
    ).output;
    expect(output).toMatchObject({
      items: Array.from({ length: 100 }, () => value),
      pageCount: 100,
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
