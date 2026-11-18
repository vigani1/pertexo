import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createControlListener } from './control-listener.js';

const webRequire = createRequire(
  new URL('../../../../web/package.json', import.meta.url),
);
// The journeys' reports come from Playwright's request context, so the test
// uses that client, loaded from the web app that owns the dependency.
type ReportClient = Readonly<{
  post(
    url: string,
    options: { data: unknown },
  ): Promise<{ status(): number; headers(): Record<string, string> }>;
  dispose(): Promise<void>;
}>;
const { request } = webRequire('@playwright/test') as {
  request: { newContext(): Promise<ReportClient> };
};

describe('browser control listener', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it('never leaves Playwright an idle socket that the listener could close under a later report', async () => {
    let connections = 0;
    const listener = createControlListener((incoming, response) => {
      incoming.resume();
      incoming.on('end', () => response.writeHead(204).end());
    });
    listener.on('connection', () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => {
      listener.listen(0, '127.0.0.1', resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          listener.close(() => {
            resolve();
          });
        }),
    );
    const origin = `http://127.0.0.1:${String((listener.address() as AddressInfo).port)}`;
    const client = await request.newContext();
    cleanups.push(() => client.dispose());

    const first = await client.post(`${origin}/report`, { data: { n: 1 } });
    const second = await client.post(`${origin}/report`, { data: { n: 2 } });

    expect([first.status(), second.status()]).toEqual([204, 204]);
    expect(first.headers().connection).toBe('close');
    expect(connections).toBe(2);
  });
});
