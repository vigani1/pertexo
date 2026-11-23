import { expect, it } from 'vitest';
import { API_KEY, chat, fakeModel, json, schema } from './model.fixture.js';

const structured = { mode: 'structured', outputSchema: schema };

it.each([
  ['credential_rejected', json({ error: API_KEY }, 401)],
  ['model_unavailable', json({ error: API_KEY }, 404)],
  ['output_truncated', json(chat('partial', 'length'))],
  ['output_refused', json(chat(null, 'stop', 'refused'))],
  ['invalid_response', json({ answer: 'unknown envelope' })],
  ['response_too_large', json(chat('é'.repeat(65_536)))],
  ['credential_echoed', json(chat(`{"count":"${API_KEY}"}`))],
  ['address_denied', json({}, 302, { location: '/different' })],
] as const)(
  'returns a safe %s failure without sending a repair',
  async (code, answer) => {
    await using fake = await fakeModel([answer]);
    const result = fake.execute({ config: structured });
    await expect(result).rejects.toMatchObject({
      kind: 'failed',
      safeErrorCode: `model.${code}`,
    });
    const failure: unknown = await result.catch((error: unknown) => error);
    expect(JSON.stringify(failure)).not.toContain(API_KEY);
    expect(fake.calls).toHaveLength(1);
  },
);

it('refuses a blocked address before dispatch', async () => {
  await using fake = await fakeModel([]);
  await expect(fake.execute({ denyAddress: true })).rejects.toMatchObject({
    safeErrorCode: 'model.address_denied',
    possiblyDispatched: false,
  });
  expect(fake.calls).toHaveLength(0);
  expect(fake.dispatches()).toBe(0);
});

it('refuses a UTF-8 request over the wire limit before dispatch', async () => {
  await using fake = await fakeModel([]);
  await expect(
    fake.execute({ prompt: 'é'.repeat(32_768) }),
  ).rejects.toMatchObject({
    safeErrorCode: 'model.request_too_large',
    possiblyDispatched: false,
  });
  expect(fake.calls).toHaveLength(0);
  expect(fake.dispatches()).toBe(0);
});

it('refuses an oversized repair while preserving the first dispatch', async () => {
  await using fake = await fakeModel([json(chat('x'.repeat(65_536)))]);
  await expect(fake.execute({ config: structured })).rejects.toMatchObject({
    safeErrorCode: 'model.request_too_large',
    possiblyDispatched: true,
  });
  expect(fake.calls).toHaveLength(1);
  expect(fake.dispatches()).toBe(1);
});

it.each([429, 503])(
  'stops on %s when Retry-After exceeds the maximum',
  async (status) => {
    await using fake = await fakeModel([
      json({}, status, { 'retry-after': '61' }),
    ]);
    await expect(fake.execute()).rejects.toMatchObject({
      kind: 'failed',
      safeErrorCode: 'model.retry_after_exceeded',
    });
    expect(fake.calls).toHaveLength(1);
  },
);

it('uses one timeout across a repair that never finishes', async () => {
  await using fake = await fakeModel([json(chat('{}')), () => undefined]);
  await expect(
    fake.execute({ config: { ...structured, timeoutMillis: 500 } }),
  ).rejects.toMatchObject({
    kind: 'retry',
    safeErrorCode: 'model.provider_timeout',
  });
  expect(fake.calls).toHaveLength(2);
});

it('respects a shorter worker deadline', async () => {
  await using fake = await fakeModel([() => undefined]);
  await expect(
    fake.execute({ deadlineAt: new Date(Date.now() + 500) }),
  ).rejects.toMatchObject({
    kind: 'retry',
    safeErrorCode: 'model.provider_timeout',
  });
  expect(fake.calls).toHaveLength(1);
});

it('preserves cancellation after the provider receives the request', async () => {
  const controller = new AbortController();
  await using fake = await fakeModel([
    () => {
      controller.abort();
    },
  ]);
  await expect(
    fake.execute({ signal: controller.signal }),
  ).rejects.toMatchObject({
    kind: 'canceled',
    possiblyDispatched: true,
  });
  expect(fake.calls).toHaveLength(1);
});

it('rejects an API key assembled from Messages text blocks', async () => {
  const split = API_KEY.indexOf('-');
  await using fake = await fakeModel([
    json({
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: API_KEY.slice(0, split) },
        { type: 'text', text: API_KEY.slice(split) },
      ],
    }),
  ]);
  await expect(fake.execute({ endpoint: 'anthropic' })).rejects.toMatchObject({
    safeErrorCode: 'model.credential_echoed',
  });
  expect(fake.calls).toHaveLength(1);
});

it.each([false, true])(
  'rejects callback credential echoes with repair=%s',
  async (repair) => {
    const secret = 'synthetic-callback-secret';
    const echo = json(chat(JSON.stringify({ count: 1, secret })));
    await using fake = await fakeModel(
      repair ? [json(chat('{}')), echo] : [echo],
    );
    await expect(
      fake.execute({
        config: structured,
        prompt: secret,
        callbacks: {
          prepare: async () => ({}),
          sensitiveValues: () => [secret],
        },
      }),
    ).rejects.toMatchObject({ safeErrorCode: 'model.credential_echoed' });
    expect(fake.calls).toHaveLength(repair ? 2 : 1);
  },
);
