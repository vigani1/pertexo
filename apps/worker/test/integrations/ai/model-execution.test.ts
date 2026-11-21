import { expect, it } from 'vitest';
import { API_KEY, chat, fakeModel, json, schema } from './model.fixture.js';

const structured = { mode: 'structured', outputSchema: schema };

it('returns text from Chat Completions and Messages using the same mapped prompt', async () => {
  await using fake = await fakeModel([
    json(chat('chat answer')),
    json({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'messages answer' }],
    }),
  ]);
  await expect(fake.execute()).resolves.toMatchObject({
    output: { text: 'chat answer' },
  });
  await expect(fake.execute({ endpoint: 'anthropic' })).resolves.toMatchObject({
    output: { text: 'messages answer' },
  });
  expect(fake.calls).toMatchObject([
    {
      path: '/local/v1/chat/completions',
      authorization: `Bearer ${API_KEY}`,
      request: {
        model: 'fake',
        max_completion_tokens: 1_024,
        messages: [{ content: 'mapped task' }],
      },
    },
    {
      path: '/local/v1/messages',
      apiKey: API_KEY,
      version: '2023-06-01',
      request: {
        model: 'fake',
        max_tokens: 1_024,
        messages: [{ content: 'mapped task' }],
      },
    },
  ]);
  expect(fake.dispatches()).toBe(2);
});

it('uses each endpoint’s structured-output protocol and only publishes validated data', async () => {
  await using fake = await fakeModel([
    json(chat('{"count":1}')),
    json(chat('{"count":2}')),
    json({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', name: 'return_output', input: { count: 3 } },
      ],
    }),
  ]);
  for (const [endpoint, count] of [
    ['openai', 1],
    ['openrouter', 2],
    ['anthropic', 3],
  ] as const) {
    await expect(
      fake.execute({
        endpoint,
        config: { ...structured, maxOutputTokens: 4_096 },
      }),
    ).resolves.toMatchObject({ output: { data: { count } } });
  }
  expect(fake.calls[0]?.request).toMatchObject({
    response_format: { type: 'json_object' },
    max_completion_tokens: 4_096,
    messages: [
      { content: expect.stringContaining(JSON.stringify(schema)) as unknown },
    ],
  });
  expect(fake.calls[1]?.request).not.toHaveProperty('response_format');
  expect(fake.calls[2]?.request).toMatchObject({
    tools: [{ name: 'return_output', input_schema: schema }],
    tool_choice: {
      type: 'tool',
      name: 'return_output',
      disable_parallel_tool_use: true,
    },
  });
  expect(fake.dispatches()).toBe(3);
});

it.each(['malformed {', '{"count":"1"}', '{"count":1,"extra":true}'])(
  'repairs %s once under the original dispatch marker',
  async (answer) => {
    await using fake = await fakeModel([
      json(chat(answer)),
      json(chat('{"count":7}')),
    ]);
    await expect(fake.execute({ config: structured })).resolves.toMatchObject({
      output: { data: { count: 7 } },
    });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.request).toMatchObject({
      messages: [
        { content: expect.stringContaining(JSON.stringify(answer)) as unknown },
      ],
    });
    expect(fake.dispatches()).toBe(1);
  },
);

it('fails after one unsuccessful repair', async () => {
  await using fake = await fakeModel([
    json(chat('{}')),
    json(chat('{"count":"7"}')),
  ]);
  await expect(fake.execute({ config: structured })).rejects.toMatchObject({
    kind: 'failed',
    safeErrorCode: 'model.output_schema_invalid',
  });
  expect(fake.calls).toHaveLength(2);
  expect(fake.dispatches()).toBe(1);
});

it('checks the enrolled key again before dispatching a repair', async () => {
  await using fake = await fakeModel([
    (response, call) => {
      fake.rotate();
      json(chat('{}'))(response, call);
    },
  ]);
  await expect(fake.execute({ config: structured })).rejects.toMatchObject({
    kind: 'failed',
    safeErrorCode: 'model.credential_rejected',
  });
  expect(fake.calls).toHaveLength(1);
  expect(fake.dispatches()).toBe(1);
});
