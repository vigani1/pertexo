import { expect, it } from 'vitest';
import { chat, fakeModel, json, schema } from './model.fixture.js';
import { executorFailureCompletion } from '../../../src/attempts/delivery/executor-failure.js';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';

const structured = { mode: 'structured', outputSchema: schema };

it('accounts for Chat Completions text and Messages extraction', async () => {
  await using fake = await fakeModel([
    json({
      ...chat('answer'),
      usage: { prompt_tokens: 12, completion_tokens: 0 },
    }),
    json({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', name: 'return_output', input: { count: 3 } },
      ],
      usage: { input_tokens: 31, output_tokens: 7 },
    }),
  ]);
  expect((await fake.execute()).modelUsage).toEqual({
    kind: 'complete',
    model: 'fake',
    inputTokens: 12,
    outputTokens: 0,
  });
  expect(
    (await fake.execute({ endpoint: 'anthropic', config: structured }))
      .modelUsage,
  ).toEqual({
    kind: 'complete',
    model: 'fake',
    inputTokens: 31,
    outputTokens: 7,
  });
});

it('adds the rejected answer and repair usage', async () => {
  await using fake = await fakeModel([
    json({ ...chat('{}'), usage: { prompt_tokens: 12, completion_tokens: 2 } }),
    json({
      ...chat('{"count":3}'),
      usage: { prompt_tokens: 30, completion_tokens: 4 },
    }),
  ]);
  expect((await fake.execute({ config: structured })).modelUsage).toEqual({
    kind: 'complete',
    model: 'fake',
    inputTokens: 42,
    outputTokens: 6,
  });
});

it.each([
  [undefined, null],
  [{ prompt_tokens: -1, completion_tokens: Number.MAX_VALUE }, null],
  [{ prompt_tokens: 12, completion_tokens: 0.1 }, 12],
])(
  'keeps absent or invalid counts unknown (%j)',
  async (usage, inputTokens) => {
    await using fake = await fakeModel([json({ ...chat('answer'), usage })]);
    expect((await fake.execute()).modelUsage).toEqual({
      kind: 'incomplete',
      model: 'fake',
      inputTokens,
      outputTokens: null,
    });
  },
);

it('keeps reported usage when a repair fails after dispatch', async () => {
  await using fake = await fakeModel([
    json({ ...chat('{}'), usage: { prompt_tokens: 12, completion_tokens: 2 } }),
    json({}, 500),
  ]);
  try {
    await fake.execute({ config: structured });
    expect.unreachable();
  } catch (error) {
    if (!(error instanceof NodeExecutorFailure)) throw error;
    expect(executorFailureCompletion(error)).toMatchObject({
      modelUsage: {
        kind: 'incomplete',
        model: 'fake',
        inputTokens: 12,
        outputTokens: 2,
      },
    });
  }
});

it('retains complete usage from an answer rejected by the adapter', async () => {
  await using fake = await fakeModel([
    json({
      ...chat(null, 'length'),
      usage: { prompt_tokens: 12, completion_tokens: 2 },
    }),
  ]);
  await expect(fake.execute()).rejects.toMatchObject({
    safeErrorCode: 'model.output_truncated',
    modelUsage: {
      kind: 'complete',
      model: 'fake',
      inputTokens: 12,
      outputTokens: 2,
    },
  });
});
