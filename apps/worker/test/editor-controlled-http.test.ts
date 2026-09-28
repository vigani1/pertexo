import { afterEach, describe, expect, it } from 'vitest';
import {
  controlledActionUrl,
  createEditorControlledHttpTarget,
} from './support/editor-controlled-http.js';

describe('owned controlled HTTP transport', () => {
  const owners: ReturnType<typeof createEditorControlledHttpTarget>[] = [];
  afterEach(async () => {
    await Promise.all(owners.splice(0).map((owner) => owner.close()));
  });
  const target = (beforeResponse?: () => Promise<void>) => {
    const owner = createEditorControlledHttpTarget(
      'Bearer test-only-credential',
      beforeResponse,
    );
    owners.push(owner);
    return owner;
  };
  const material = () => ({
    url: new URL(controlledActionUrl),
    method: 'POST' as const,
    address: { address: '8.8.8.8', family: 4 as const },
    headers: {
      authorization: 'Bearer test-only-credential',
      'content-type': 'application/json',
    },
    body: Buffer.from('{"marker":"true-branch","amount":7}'),
    timeoutMillis: 1_000,
  });

  it('returns actual bounded server status, headers, bytes and effect observation', async () => {
    const owned = target();
    await owned.start();
    let markers = 0;
    const response = await owned.httpClient.execute({
      url: controlledActionUrl,
      method: 'POST',
      headers: material().headers,
      body: material().body,
      timeoutMillis: 1_000,
      maxResponseBytes: 4_096,
      maxRedirects: 0,
      beforeDispatch: () => {
        markers++;
        return Promise.resolve();
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json');
    expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({
      accepted: true,
      body: { marker: 'true-branch', amount: 7 },
    });
    expect(markers).toBe(1);
    expect(owned.observe()).toMatchObject({
      requests: 1,
      effects: 1,
      bodies: ['{"marker":"true-branch","amount":7}'],
    });
  });

  it.each([
    { url: new URL('https://other.example.test/effect') },
    { url: new URL(`${controlledActionUrl}?redirect=http://127.0.0.1`) },
    { url: new URL(`${controlledActionUrl}#secret`) },
    { method: 'GET' as const },
    { address: { address: '127.0.0.1', family: 4 as const } },
    { address: { address: '8.8.4.4', family: 4 as const } },
    { headers: { cookie: 'never-forwarded' } },
    { body: new Uint8Array(4_097) },
    { signal: AbortSignal.abort() },
  ])(
    'rejects a changed dispatch target/material before any socket opens: %#',
    async (change) => {
      const owned = target();
      await owned.start();
      await expect(
        owned.transport.dispatch({ ...material(), ...change }),
      ).rejects.toThrow('Owned HTTP dispatch rejected');
      expect(owned.observe()).toEqual({
        requests: 0,
        effects: 0,
        bodies: [],
        sockets: 0,
      });
    },
  );

  it('has no DNS fallback and keeps private-address rejection before dispatch evidence', async () => {
    const owned = target();
    await owned.start();
    let markers = 0;
    for (const url of [
      'https://127.0.0.1/effect',
      'https://other.example.test/effect',
    ]) {
      await expect(
        owned.httpClient.execute({
          url,
          method: 'POST',
          body: material().body,
          headers: material().headers,
          timeoutMillis: 1_000,
          maxResponseBytes: 4_096,
          maxRedirects: 0,
          beforeDispatch: () => {
            markers++;
            return Promise.resolve();
          },
        }),
      ).rejects.toThrow();
    }
    expect(markers).toBe(0);
    expect(owned.observe().requests).toBe(0);
  });

  it('cancels a dispatched exchange, closes late response and never repeats its effect', async () => {
    const barrier = Promise.withResolvers<undefined>();
    const owned = target(() => barrier.promise);
    await owned.start();
    const controller = new AbortController();
    const pending = owned.transport.dispatch({
      ...material(),
      signal: controller.signal,
    });
    const failure = expect(pending).rejects.toThrow(
      'Owned HTTP exchange failed',
    );
    await expect.poll(() => owned.observe().effects).toBe(1);
    controller.abort(new Error('secret-not-reported'));
    await failure;
    barrier.resolve(undefined);
    await owned.close();
    await owned.close();
    expect(owned.observe().effects).toBe(1);
    await expect(owned.transport.dispatch(material())).rejects.toThrow(
      'Owned HTTP dispatch rejected',
    );
  });

  it('disposes before startup without opening a late server', async () => {
    const owned = target();
    await owned.close();
    await expect(owned.start()).rejects.toThrow('Owned HTTP server disposed');
    expect(owned.observe().requests).toBe(0);
  });
});
