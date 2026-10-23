import { describe, expect, it } from 'vitest';

import { server, json, setup } from '../../support/pagination.js';
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
      const pagination = paginationFor(mode);
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
        response.end(invalidPageBody(kind));
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
});

function paginationFor(mode: string) {
  switch (mode) {
    case 'link_header':
      return { mode: 'next_link', source: { kind: 'link_header' } };
    case 'next_link':
      return { mode, source: { kind: 'body', path: '$.next' } };
    case 'cursor':
      return { mode, cursorPath: '$.next', parameter: 'cursor' };
    case 'offset':
      return { mode, parameter: 'offset', step: 2 };
    default:
      return { mode, parameter: 'page' };
  }
}

function invalidPageBody(kind: string): string {
  if (kind === 'malformed') return '{bad';
  if (kind === 'missing_list') return '{}';
  return JSON.stringify({ data: ['x'.repeat(kind === 'large' ? 2000 : 1)] });
}
