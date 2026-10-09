import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ConnectionEnvelopeEncryption,
  classifySecureHttpResponse,
  type ConnectionSecretContext,
  type SecureHttpRequest,
} from '@pertexo/integrations/server';
import {
  CURATED_TEMPLATE_FIXTURE,
  createCuratedTemplateEnvelopeContext,
} from '../../../../../infrastructure/testing/curated-template-envelope-context.mjs';
import {
  createCuratedTemplateControlledTransports,
  createCuratedTemplateQualificationTransports,
} from './controlled-transports.js';

function httpRequest(
  overrides: Partial<SecureHttpRequest> = {},
): SecureHttpRequest {
  return {
    url: CURATED_TEMPLATE_FIXTURE.httpEndpoint,
    method: 'GET',
    headers: { authorization: CURATED_TEMPLATE_FIXTURE.httpAuthorization },
    timeoutMillis: 1000,
    maxRedirects: 0,
    maxResponseBytes: 1024,
    beforeDispatch: () => Promise.resolve(),
    ...overrides,
  };
}
function slackRequest() {
  return {
    botToken: CURATED_TEMPLATE_FIXTURE.slackBotToken,
    channelId: CURATED_TEMPLATE_FIXTURE.slackChannel,
    text: CURATED_TEMPLATE_FIXTURE.slackText,
    timeoutMillis: 1000,
    signal: new AbortController().signal,
    beforeDispatch: () => Promise.resolve(),
  };
}

describe('owned curated-template provider transports', () => {
  it('does not mistake an exhausted two-response plan for an observed 500 response', async () => {
    const stale = createCuratedTemplateControlledTransports([200, 204]);
    try {
      for (const status of [200, 204]) {
        const response = await stale.httpClient.execute(httpRequest());
        expect(response.status).toBe(status);
        response.body.fill(0);
      }
      await expect(stale.httpClient.execute(httpRequest())).rejects.toThrow();
      expect(stale.observe().pendingHttpResponses).toBe(0);
      expect(stale.observe().observations.map((item) => item.status)).toEqual([
        200, 204,
      ]);
    } finally {
      await stale.close();
    }
  });
  it('returns the exact controlled 500 through real guards and preserves unsafe outcome-unknown policy', async () => {
    const fixture = createCuratedTemplateControlledTransports([500]);
    try {
      const response = await fixture.httpClient.execute(httpRequest());
      expect(response.status).toBe(500);
      response.body.fill(0);
      expect(
        classifySecureHttpResponse(response.status, 'unsafe', false),
      ).toEqual({ kind: 'outcome_unknown', errorKind: 'provider' });
      expect(fixture.observe()).toEqual({
        observations: [
          {
            kind: 'http',
            status: 500,
            bodyHash: createHash('sha256')
              .update(new Uint8Array())
              .digest('hex'),
          },
        ],
        pendingHttpResponses: 0,
      });
    } finally {
      await fixture.close();
    }
  });
  it.each([
    { statuses: [501] },
    { statuses: [400] },
    { statuses: [200, 204, 500, 429] },
  ])('fails closed for unplanned response codes %j', ({ statuses }) => {
    expect(() => createCuratedTemplateControlledTransports(statuses)).toThrow();
  });
  it('retains unconsumed response-count evidence after disposal', async () => {
    const fixture = createCuratedTemplateControlledTransports([200, 204]);
    await fixture.close();
    expect(fixture.observe()).toEqual({
      observations: [],
      pendingHttpResponses: 2,
    });
  });
  it.each(['127.0.0.1', '10.0.0.1', '1.1.1.1'])(
    'rejects transport address %s instead of creating a private-address exception',
    async (address) => {
      const fixture = createCuratedTemplateControlledTransports();
      try {
        await expect(
          fixture.transport.dispatch({
            url: new URL(CURATED_TEMPLATE_FIXTURE.httpEndpoint),
            method: 'GET',
            headers: {
              authorization: CURATED_TEMPLATE_FIXTURE.httpAuthorization,
            },
            timeoutMillis: 1000,
            address: { address, family: 4 },
          }),
        ).rejects.toThrow();
        expect(fixture.observe().observations).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );
  it('uses the actual secure HTTP/Slack clients with bounded controlled branch results and hash-only evidence', async () => {
    const fixture = createCuratedTemplateQualificationTransports();
    try {
      const beforeDispatch = vi.fn(() => Promise.resolve());
      const response = await fixture.httpClient.execute(
        httpRequest({ beforeDispatch }),
      );
      expect(response.status).toBe(200);
      expect(beforeDispatch).toHaveBeenCalledTimes(1);
      response.body.fill(0);
      expect(await fixture.slackClient.sendMessage(slackRequest())).toEqual({
        kind: 'succeeded',
        channelId: CURATED_TEMPLATE_FIXTURE.slackChannel,
        messageTs: '1700000000.000001',
      });
      const skipped = await fixture.httpClient.execute(httpRequest());
      expect(skipped.status).toBe(204);
      expect(skipped.body.byteLength).toBe(0);
      const failed = await fixture.httpClient.execute(httpRequest());
      expect(failed.status).toBe(500);
      failed.body.fill(0);
      expect(
        classifySecureHttpResponse(failed.status, 'unsafe', false),
      ).toEqual({ kind: 'outcome_unknown', errorKind: 'provider' });
      const observed = fixture.observe();
      expect(observed.pendingHttpResponses).toBe(0);
      expect(
        observed.observations.map(({ kind, status }) => ({ kind, status })),
      ).toEqual([
        { kind: 'http', status: 200 },
        { kind: 'slack', status: 200 },
        { kind: 'http', status: 204 },
        { kind: 'http', status: 500 },
      ]);
      expect(
        observed.observations.every(({ bodyHash }) =>
          /^[a-f0-9]{64}$/u.test(bodyHash),
        ),
      ).toBe(true);
      expect(JSON.stringify(observed)).not.toContain(
        CURATED_TEMPLATE_FIXTURE.slackBotToken,
      );
      expect(JSON.stringify(observed)).not.toContain(
        CURATED_TEMPLATE_FIXTURE.slackText,
      );
      await expect(fixture.httpClient.execute(httpRequest())).rejects.toThrow();
      expect(fixture.observe().observations).toHaveLength(4);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    { url: 'https://example.com/result' },
    { url: `${CURATED_TEMPLATE_FIXTURE.httpEndpoint}?extra=1` },
    { method: 'POST' as const },
    { headers: { authorization: 'Bearer real-looking-but-unapproved' } },
    {
      headers: {
        authorization: CURATED_TEMPLATE_FIXTURE.httpAuthorization,
        extra: 'x',
      },
    },
    { timeoutMillis: 2000 },
  ])(
    'rejects any HTTP input outside the reviewed fixture before effects',
    async (override) => {
      const fixture = createCuratedTemplateControlledTransports();
      try {
        await expect(
          fixture.httpClient.execute(httpRequest(override)),
        ).rejects.toThrow();
        expect(fixture.observe().observations).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );

  it.each([
    { botToken: 'xoxb-unapproved' },
    { channelId: 'COTHER' },
    { text: 'Other message' },
    { timeoutMillis: 2000 },
  ])('rejects unreviewed Slack input before effects', async (override) => {
    const fixture = createCuratedTemplateControlledTransports();
    try {
      await expect(
        fixture.slackClient.sendMessage({ ...slackRequest(), ...override }),
      ).rejects.toThrow();
      expect(fixture.observe().observations).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it('retains real before-dispatch authority and cancellation fences', async () => {
    const fixture = createCuratedTemplateControlledTransports();
    try {
      await expect(
        fixture.slackClient.sendMessage({
          ...slackRequest(),
          beforeDispatch: () => Promise.reject(new Error('authority revoked')),
        }),
      ).rejects.toThrow();
      const controller = new AbortController();
      controller.abort();
      await expect(
        fixture.httpClient.execute(httpRequest({ signal: controller.signal })),
      ).rejects.toThrow();
      expect(fixture.observe().observations).toEqual([]);
      await fixture.close();
      await expect(fixture.httpClient.execute(httpRequest())).rejects.toThrow();
      await expect(
        fixture.slackClient.sendMessage(slackRequest()),
      ).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });
});

describe('shared owned curated envelope context', () => {
  it('shares synthetic envelopes across API/worker only with exact authenticated identities and live owned keys', async () => {
    const master = randomBytes(32).toString('hex');
    const apiKeys =
      createCuratedTemplateEnvelopeContext<ConnectionSecretContext>(master);
    const workerKeys =
      createCuratedTemplateEnvelopeContext<ConnectionSecretContext>(master);
    const api = new ConnectionEnvelopeEncryption(apiKeys);
    const worker = new ConnectionEnvelopeEncryption(workerKeys);
    const context = {
      workspaceId: randomUUID(),
      connectionId: randomUUID(),
      secretVersionId: randomUUID(),
    };
    const plaintext = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        type: 'slack_bot_token',
        botToken: CURATED_TEMPLATE_FIXTURE.slackBotToken,
      }),
    );
    try {
      const sealed = await api.seal(plaintext, context);
      const opened = await worker.open(sealed, context);
      expect(createHash('sha256').update(opened).digest('hex')).toBe(
        createHash('sha256').update(plaintext).digest('hex'),
      );
      opened.fill(0);
      await expect(
        worker.open(sealed, { ...context, workspaceId: randomUUID() }),
      ).rejects.toThrow();
      await expect(
        worker.open(sealed, { ...context, connectionId: randomUUID() }),
      ).rejects.toThrow();
      await expect(
        worker.open(sealed, { ...context, secretVersionId: randomUUID() }),
      ).rejects.toThrow();
      workerKeys.close();
      await expect(worker.open(sealed, context)).rejects.toThrow();
      apiKeys.close();
      await expect(api.seal(plaintext, context)).rejects.toThrow();
    } finally {
      plaintext.fill(0);
      apiKeys.close();
      workerKeys.close();
    }
  });
  it.each(['', 'x'.repeat(64), 'a'.repeat(62), 'A'.repeat(64)])(
    'rejects invalid explicit master context',
    (master) => {
      expect(() => createCuratedTemplateEnvelopeContext(master)).toThrow();
    },
  );
});
