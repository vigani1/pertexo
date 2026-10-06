import { describe, expect, it, vi } from 'vitest';
import { prepareNodeAttemptPhysicalOutput } from '../src/execution/node-attempt-physical-output.js';
import { createWorkflowExecutionValueInlinePreparation } from '../src/execution/workflow-execution-value-codec.js';
import { lease } from './support/node-attempt-handler.fixture.js';

const request = () => ({
  lease: lease(),
  native: true,
  callAlias: false,
  value: null,
  signal: new AbortController().signal,
  values: undefined,
});
describe('framework physical-output preparation under the heartbeat signal', () => {
  it('uses existing inline preparation and exact physical producer scope', async () => {
    const inline = createWorkflowExecutionValueInlinePreparation();
    const prepare = vi.fn(inline.prepare);
    const input = { ...request(), values: { prepare } };
    await expect(
      prepareNodeAttemptPhysicalOutput(input),
    ).resolves.toMatchObject({
      reference: { schemaVersion: 1, kind: 'inline', value: null },
      sha256:
        '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      byteLength: 4,
    });
    expect(prepare).toHaveBeenCalledExactlyOnceWith({
      owner: { kind: 'attempt', slot: 'physical_output', lease: input.lease },
      value: null,
      signal: input.signal,
    });
  });
  it.each([
    { native: false, callAlias: false },
    { native: true, callAlias: true },
  ])(
    'preserves retained/Call alias without producing or inspecting values: %j',
    async (mode) => {
      const prepare = vi.fn();
      const value = {
        get unsafe(): never {
          throw new Error('must not inspect');
        },
      };
      await expect(
        prepareNodeAttemptPhysicalOutput({
          ...request(),
          ...mode,
          value,
          values: { prepare },
        }),
      ).resolves.toBeUndefined();
      expect(prepare).not.toHaveBeenCalled();
    },
  );
  it('starts no preparation after cancellation and discards joined preparation on cancellation', async () => {
    const controller = new AbortController();
    const prepare = vi.fn(
      createWorkflowExecutionValueInlinePreparation().prepare,
    );
    controller.abort();
    await expect(
      prepareNodeAttemptPhysicalOutput({
        ...request(),
        signal: controller.signal,
        values: { prepare },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(prepare).not.toHaveBeenCalled();
    const later = new AbortController();
    await expect(
      prepareNodeAttemptPhysicalOutput({
        ...request(),
        signal: later.signal,
        values: {
          prepare: async (input) => {
            const result = await prepare(input);
            later.abort();
            return result;
          },
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('separates invalid producer values from preparation outages', async () => {
    await expect(
      prepareNodeAttemptPhysicalOutput({ ...request(), value: Infinity }),
    ).rejects.toMatchObject({ name: 'NodeAttemptOutputInvalidError' });
    const unavailable = new Error('artifact preparation unavailable');
    await expect(
      prepareNodeAttemptPhysicalOutput({
        ...request(),
        values: { prepare: () => Promise.reject(unavailable) },
      }),
    ).rejects.toBe(unavailable);
  });
});
