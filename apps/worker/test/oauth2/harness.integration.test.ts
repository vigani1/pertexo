import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeOAuth2,
  startOAuth2Harness,
  useOAuth2Timeouts,
  WEB_ORIGIN,
  type OAuth2Harness,
} from '../support/oauth2/harness.js';
import {
  startTraceCollector,
  TRACE_ENVIRONMENT,
} from '../support/oauth2/traces.js';

useOAuth2Timeouts();

// The harness stands on what exists today, so every `it.fails` elsewhere fails for
// its own reason. Header connections already run through all of this.
describeOAuth2('the OAuth2 test harness on a header connection', () => {
  let harness: OAuth2Harness;

  beforeAll(async () => {
    harness = await startOAuth2Harness('harness');
  });
  afterAll(async () => {
    await harness.close();
  });

  const headerConnection = async (
    owner: Awaited<ReturnType<OAuth2Harness['newOwner']>>,
    value: string,
  ): Promise<string> => {
    const created = await owner.api.call(
      'POST',
      `/v1/workspaces/${owner.workspaceId}/connections`,
      {
        providerKey: 'http',
        name: `Headers ${randomUUID().slice(0, 8)}`,
        credential: {
          type: 'http_headers',
          headers: { authorization: value },
        },
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return (created.json as { id: string }).id;
  };

  it('runs a published step with a connection, to the stand-in, and reads its facts', async () => {
    const { standIn } = harness;
    const owner = await harness.newOwner();
    const clientId = standIn.newClient('non-rotating');
    const token = await (
      await fetch(`${standIn.origin}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
        }).toString(),
      })
    ).json();
    const connectionId = await headerConnection(
      owner,
      `Bearer ${(token as { access_token: string }).access_token}`,
    );
    for (const method of [
      'GET',
      'HEAD',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
    ] as const) {
      const runId = await harness.run(owner, {
        connectionId,
        method,
        url: harness.apiUrl(),
      });
      const facts = await harness.finish(runId);
      expect(facts.status, method).toBe('succeeded');
      const [attempt] = await harness.attempts(runId);
      expect(attempt?.status, method).toBe('succeeded');
      expect(attempt?.safe_error_code, method).toBeNull();
      expect(attempt?.dispatch_marked_at, method).not.toBeNull();
    }
    expect(standIn.apiCalls(clientId).map(({ method }) => method)).toEqual([
      'GET',
      'HEAD',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
    ]);
  });

  it('runs a paged GET through the pages the stand-in serves', async () => {
    const { standIn } = harness;
    const owner = await harness.newOwner();
    const clientId = standIn.newClient('non-rotating');
    const token = await (
      await fetch(`${standIn.origin}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
        }).toString(),
      })
    ).json();
    const connectionId = await headerConnection(
      owner,
      `Bearer ${(token as { access_token: string }).access_token}`,
    );
    const runId = await harness.run(owner, {
      connectionId,
      method: 'GET',
      url: harness.apiUrl('/api/pages?page=1'),
      pagination: {
        mode: 'next_link',
        source: { kind: 'body', path: '$.next' },
        itemsPath: '$.items',
        maxPages: 10,
        delayMillis: 0,
      },
    });
    expect((await harness.finish(runId)).status).toBe('succeeded');
    expect(
      standIn.apiCalls(clientId).map(({ query }) => Number(query.page)),
    ).toEqual([1, 2, 3, 4]);
  });

  it('shows a 401 from the API as an authentication failure in the stored facts', async () => {
    const owner = await harness.newOwner();
    const connectionId = await headerConnection(owner, 'Bearer not-a-token');
    const runId = await harness.run(owner, {
      connectionId,
      method: 'POST',
      url: harness.apiUrl(),
    });
    expect((await harness.finish(runId)).status).toBe('failed');
    const [attempt] = await harness.attempts(runId);
    expect(attempt?.executor_error_kind).toBe('authentication');
    expect(attempt?.executor_possibly_dispatched).toBe(true);
  });

  it('resolves test names: routed to the stand-in, dialled, and refused', async () => {
    const owner = await harness.newOwner();
    const connectionId = await headerConnection(owner, 'Bearer not-a-token');
    const seenAt = (host: string) =>
      harness.standIn.requests.filter((request) =>
        request.host?.startsWith(host),
      ).length;

    // A dialled name connects for real to the address it resolves to.
    const port = new URL(harness.standIn.origin).port;
    await harness.finish(
      await harness.run(owner, {
        connectionId,
        method: 'GET',
        url: `http://api.listed.example.test:${port}/api`,
        retry: { maximumAttempts: 1, delayMillis: 1_000 },
      }),
    );
    expect(seenAt('api.listed.example.test')).toBe(1);

    // A connection test takes HTTPS only, and a routed name answers it.
    const tested = await harness.test(
      owner,
      connectionId,
      'https://api.public.example.test/api',
    );
    expect(tested.status, JSON.stringify(tested.json)).toBe(200);
    expect(harness.standIn.requests.at(-1)?.path).toBe('/api');
    expect(tested.json).toMatchObject({ outcome: { httpStatus: 401 } });

    // A private name is refused by the real transport before anything is sent.
    const refused = await harness.run(owner, {
      connectionId,
      method: 'GET',
      url: 'http://private.example.test/never',
      retry: { maximumAttempts: 1, delayMillis: 1_000 },
    });
    expect((await harness.finish(refused)).status).toBe('failed');
    expect(
      harness.standIn.requests.filter(({ path }) => path.startsWith('/leak')),
    ).toEqual([]);
  });

  it('adds members by role, with the capabilities the plan names', async () => {
    const owner = await harness.newOwner();
    const capabilities = async (
      role: Parameters<OAuth2Harness['addMember']>[1],
    ) => {
      const member = await harness.addMember(owner.workspaceId, role);
      const read = await member.api.call('GET', '/v1/workspaces?limit=10');
      expect(read.status, JSON.stringify(read.json)).toBe(200);
      const { items } = read.json as {
        items: readonly { capabilities: readonly string[] }[];
      };
      return (items[0]?.capabilities ?? [])
        .filter((name) => name.startsWith('connection:'))
        .sort();
    };
    expect(await capabilities('viewer')).toEqual(['connection:read']);
    for (const role of ['operator', 'builder'] as const)
      expect(await capabilities(role)).toEqual([
        'connection:read',
        'connection:use',
      ]);
    expect(await capabilities('admin')).toEqual([
      'connection:manage',
      'connection:read',
      'connection:use',
    ]);
  });

  it('navigates like a browser returning from another site', async () => {
    const browser = harness.anonymousBrowser();
    const answer = await browser.navigate('/health/ready', () => true);
    expect(answer.status).toBe(200);
    expect(WEB_ORIGIN).toBe('http://localhost:5999');
  });
});

// Only one stack runs at a time, so this one follows the block above.
describeOAuth2('the OAuth2 test harness on an https install', () => {
  it('signs in and creates, for the Secure cookie case', async () => {
    const secure = await startOAuth2Harness('harness-https', {
      webOrigin: 'https://pertexo.example.test',
    });
    try {
      const owner = await secure.newOwner();
      const created = await owner.api.call(
        'POST',
        `/v1/workspaces/${owner.workspaceId}/connections`,
        {
          providerKey: 'http',
          name: 'Headers on https',
          credential: {
            type: 'http_headers',
            headers: { authorization: 'Bearer value' },
          },
        },
        { 'idempotency-key': randomUUID() },
      );
      expect(created.status, JSON.stringify(created.json)).toBe(201);
    } finally {
      await secure.close();
    }
  }, 240_000);
});

// S20 searches exported traces, so a search of nothing must not pass as clean.
describeOAuth2('the OAuth2 test harness with a trace collector', () => {
  it('really receives what the services export', async () => {
    const traces = await startTraceCollector();
    const traced = await startOAuth2Harness('harness-traces', {
      environment: {
        ...TRACE_ENVIRONMENT,
        OTEL_EXPORTER_OTLP_ENDPOINT: traces.origin,
      },
    });
    try {
      const owner = await traced.newOwner();
      await owner.api.call(
        'GET',
        `/v1/workspaces/${owner.workspaceId}/connections`,
      );
      await expect
        .poll(() => traces.received(), { timeout: 30_000 })
        .toContain('resourceSpans');
    } finally {
      await traced.close();
      await traces.close();
    }
  }, 240_000);
});
