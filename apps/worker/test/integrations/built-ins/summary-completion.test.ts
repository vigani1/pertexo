import { expect, it } from 'vitest';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { createCoreNodeRegistry } from '@pertexo/nodes-core/server';
import { executorFailureCompletion } from '../../../src/attempts/delivery/executor-failure.js';

it('retains the built-in summary group limit as an ordinary actionable failure', async () => {
  const error: unknown = await createCoreNodeRegistry()
    .execute({
      definition: { key: 'core.summarize', version: 1 },
      executor: { key: 'core.summarize', version: 1 },
      config: { valuePath: '$.n', groupBy: '$.g', missing: 'error' },
      input: { items: Array.from({ length: 1500 }, (_, g) => ({ g, n: 1 })) },
      signal: new AbortController().signal,
    })
    .catch((caught: unknown) => caught);
  if (!(error instanceof NodeExecutorFailure)) throw error;
  expect(executorFailureCompletion(error)).toMatchObject({
    failureKind: 'failed',
    possiblyDispatched: false,
    safeErrorCode: 'list.summary_too_large',
    errorSummary: expect.stringMatching(
      /1500 groups.*limits.*smaller batches/iu,
    ) as unknown,
  });
});
