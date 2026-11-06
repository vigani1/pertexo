import { expect, it } from 'vitest';
import { createCoreNodeRegistry } from '../../src/server.js';

it.each([
  { groups: 1500, key: (i: number) => i },
  { groups: 700, key: (i: number) => `${String(i)}:${'x'.repeat(400)}` },
])(
  'names the group/output limit for $groups admitted summary groups',
  async ({ groups, key }) => {
    await expect(
      createCoreNodeRegistry().execute({
        definition: { key: 'core.summarize', version: 1 },
        executor: { key: 'core.summarize', version: 1 },
        config: { valuePath: '$.n', groupBy: '$.g', missing: 'error' },
        input: {
          items: Array.from({ length: groups }, (_, i) => ({
            g: key(i),
            n: 1,
          })),
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      kind: 'failed',
      possiblyDispatched: false,
      safeErrorCode: 'list.summary_too_large',
      errorSummary: expect.stringMatching(
        /groups.*(limit|bounded).*smaller batches/iu,
      ),
    });
  },
);
it('keeps a smaller admitted grouped summary usable', async () => {
  expect(
    await createCoreNodeRegistry().execute({
      definition: { key: 'core.summarize', version: 1 },
      executor: { key: 'core.summarize', version: 1 },
      config: { valuePath: '$.n', groupBy: '$.g', missing: 'error' },
      input: { items: Array.from({ length: 1400 }, (_, g) => ({ g, n: 1 })) },
      signal: new AbortController().signal,
    }),
  ).toMatchObject({
    kind: 'succeeded',
    output: {
      inputCount: 1400,
      skippedCount: 0,
      groups: expect.arrayContaining([
        { key: 1399, count: 1, sum: 1, min: 1, max: 1, average: 1 },
      ]),
    },
  });
});
