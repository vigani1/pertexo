import { expect, it } from 'vitest';
import { createCoreNodeRegistry } from '@pertexo/nodes-core/server';
import { createPlatformPreviewNodeInvoker } from '../../src/previews/preview-invoker.runtime.js';
import { leaseFixture } from './preview-runtime.fixture.js';

it.each([
  [
    { kind: 'workspace_variable', name: 'ABSENT' },
    'preview.variable_missing',
    'Input "total" uses missing workspace variable "ABSENT". Add it in Settings → Variables or update this mapping.',
  ],
  [
    {
      kind: 'expression',
      language: 'jsonata',
      expression: '$vars.ABSENT & "private-source-do-not-show"',
    },
    'preview.variable_missing',
    'Input "total" uses missing workspace variable "ABSENT". Add it in Settings → Variables or update this mapping.',
  ],
  [
    {
      kind: 'expression',
      language: 'jsonata',
      expression: '$lookup($vars, runInput.key)',
    },
    'preview.variable_missing',
    'Expression for field "total" has no variable value. Check the captured workspace variables or provide a fallback.',
  ],
  [
    { kind: 'run_input', path: 'customer.email' },
    'preview.input_invalid',
    'Input "total" (run input) uses unsupported path "customer.email". Use a path such as $.customer.email or $[0].',
  ],
] as const)(
  'shows the second mapping’s safe reason for %j',
  async (source, safeErrorCode, errorSummary) => {
    const invoker = createPlatformPreviewNodeInvoker({
      registry: createCoreNodeRegistry(),
    });
    try {
      const lease = {
        ...leaseFixture({
          id: 'node-1',
          definition: { key: 'core.set', version: 1 },
          configVersion: 1,
          config: {},
          connectionRefs: {},
          inputMappings: {
            harmless: { kind: 'literal', value: 'kept' },
            total: source,
          },
        }),
        variables: { PRESENT: 'private-value-do-not-show' },
        input: { kind: 'inline' as const, value: { key: 'ABSENT' } },
      };
      await expect(
        invoker.invoke({ lease, signal: new AbortController().signal }),
      ).resolves.toEqual({ status: 'failed', safeErrorCode, errorSummary });
    } finally {
      await invoker.close?.();
    }
  },
);

it('keeps syntactically valid absent-data mappings optional', async () => {
  const invoker = createPlatformPreviewNodeInvoker({
    registry: createCoreNodeRegistry(),
  });
  try {
    const lease = leaseFixture({
      id: 'node-1',
      definition: { key: 'core.set', version: 1 },
      configVersion: 1,
      config: {},
      connectionRefs: {},
      inputMappings: {
        harmless: { kind: 'literal', value: 'kept' },
        total: { kind: 'run_input', path: '$.absent' },
      },
    });
    await expect(
      invoker.invoke({ lease, signal: new AbortController().signal }),
    ).resolves.toEqual({ status: 'succeeded', output: { harmless: 'kept' } });
  } finally {
    await invoker.close?.();
  }
});

it('keeps long escaped field/path identifiers within the persisted diagnostic limit', async () => {
  const invoker = createPlatformPreviewNodeInvoker({
    registry: createCoreNodeRegistry(),
  });
  try {
    const lease = leaseFixture({
      id: 'node-1',
      definition: { key: 'core.set', version: 1 },
      configVersion: 1,
      config: {},
      connectionRefs: {},
      inputMappings: {
        ['\n'.repeat(200)]: { kind: 'run_input', path: '\n'.repeat(400) },
      },
    });
    const result = await invoker.invoke({
      lease,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: 'failed',
      safeErrorCode: 'preview.input_invalid',
      errorSummary: expect.stringContaining('unsupported path') as unknown,
    });
    if (result.status !== 'failed')
      throw new Error('Expected a mapping refusal');
    expect(result.errorSummary?.length).toBeLessThanOrEqual(2048);
  } finally {
    await invoker.close?.();
  }
});
