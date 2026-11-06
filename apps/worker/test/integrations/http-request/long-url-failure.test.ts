import { expect, it } from 'vitest';
import { server, setup } from '../support/pagination.js';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';

it.each(['a'.repeat(600), 'é'.repeat(150)])(
  'keeps a service refusal for an admitted long path',
  async (path) => {
    let requests = 0;
    const root = await server((url, _request, response) => {
      if (!url.pathname.startsWith('/long/')) {
        response.writeHead(404).end();
        return;
      }
      requests++;
      response
        .writeHead(404, { 'content-type': 'text/plain' })
        .end('No such item');
    });
    const error: unknown = await setup(
      `${root}/long/test-page-secret/${path}?private=hidden`,
      {},
      { singleRequest: true, credentials: true },
    )
      .run()
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      kind: 'failed',
      errorKind: 'provider',
      serviceResponse: { status: 404, method: 'GET' },
    });
    if (
      !(error instanceof NodeExecutorFailure) ||
      error.serviceResponse === undefined
    )
      throw error;
    const shown = error.serviceResponse.url;
    expect(shown.length).toBeLessThanOrEqual(512);
    expect(new URL(shown).origin).toBe(root);
    expect(new URL(shown).search).toBe('');
    expect(shown).not.toMatch(/test-page-secret|private|hidden/u);
    expect(requests).toBe(1);
  },
);
