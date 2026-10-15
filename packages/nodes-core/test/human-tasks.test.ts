import { expect, it } from 'vitest';
import { NodeInputValidationError } from '@pertexo/node-sdk/server';
import { createCoreNodeRegistry } from '../src/server.js';

const registry = createCoreNodeRegistry();
function execute(key: string, input: unknown) {
  const identity = { key, version: 1 };
  return registry.execute({
    definition: identity,
    executor: identity,
    config: {},
    input,
    signal: new AbortController().signal,
  });
}
it('captures approval facts in the declaration while preserving no-context workflows', async () => {
  const context = {
    details: { Amount: 0, Ready: false, Note: '<b>plain text</b>' },
  };
  expect(await execute('core.approval', context)).toEqual({
    kind: 'succeeded',
    output: { pending: true, context },
  });
  expect(await execute('core.approval', {})).toEqual({
    kind: 'succeeded',
    output: { pending: true, context: {} },
  });
});
it('captures partial request-input prefills using the field schema', async () => {
  const context = {
    details: { Customer: 'Ada' },
    prefill: { message: 'Suggested response' },
  };
  expect(await execute('core.request_input', context)).toEqual({
    kind: 'succeeded',
    output: { pending: true, context },
  });
  for (const input of [
    { prefill: { message: 12 } },
    { prefill: { unknown: 'value' } },
    { details: { TooBig: 'x'.repeat(8193) } },
  ])
    await expect(execute('core.request_input', input)).rejects.toBeInstanceOf(
      NodeInputValidationError,
    );
});
