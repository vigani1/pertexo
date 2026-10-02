import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PreparedNodeAttempt } from '../src/execution/node-attempt-handler.js';
import { createNodeAttemptHandler } from '../src/execution/node-attempt-handler.js';
import {
  delivery,
  executionStore,
  projection,
  registryPreparedAttempt,
} from './support/node-attempt-handler.fixture.js';

const value = { name: 'immutable' };
const canonical = JSON.stringify(value);
const snapshot = {
  reference: { schemaVersion: 1 as const, kind: 'inline' as const, value },
  byteLength: Buffer.byteLength(canonical),
  sha256: createHash('sha256').update(canonical).digest('hex'),
};
function fixture(recovered = true) {
  const read = vi.fn().mockResolvedValue(recovered ? snapshot : undefined);
  const record = vi.fn().mockResolvedValue(undefined);
  const loadInputs = vi
    .fn()
    .mockResolvedValue({
      abortRequested: false,
      completedNodeOutputs: {},
      runInput: null,
    });
  const complete = vi.fn().mockResolvedValue({ kind: 'committed' });
  const runStore = executionStore({
    loadInputs,
    complete,
    readCallDeclarationInput: read,
    recordCallDeclarationInput: record,
  });
  const prepare = vi.fn().mockResolvedValue(snapshot);
  const hydrate = vi.fn().mockResolvedValue(value);
  const execute = vi
    .fn<PreparedNodeAttempt['execute']>()
    .mockImplementation(async (input) => {
      await input.onInputResolved?.(
        input.recordedWorkflowCallInput === undefined
          ? value
          : (input.recordedWorkflowCallInput as typeof value),
      );
      return registryPreparedAttempt().execute(input);
    });
  const registry = {
    execute: vi.fn().mockResolvedValue({ kind: 'succeeded', output: value }),
  };
  const handler = createNodeAttemptHandler({
    engine: {
      prepare: () => ({
        inputPersistence: 'workflow_call_declaration',
        upstreamNodeOutputs: [{ nodeId: 'changed', invocationKey: 'changed' }],
        execute,
      }),
    },
    heartbeatIntervalMillis: 1_000,
    leaseDurationSeconds: 30,
    reader: {
      close: vi.fn(),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion: projection(),
      }),
    },
    registry,
    runStore,
    callDeclarationValues: { prepare, hydrate },
    workerId: 'worker-1',
  });
  return {
    handler,
    runStore,
    read,
    loadInputs,
    complete,
    record,
    prepare,
    hydrate,
    execute,
    registry,
  };
}
describe('required Call declaration input recovery orchestration', () => {
  it('hydrates an existing snapshot without loading changed upstream values or preparing another reservation', async () => {
    const f = fixture();
    await expect(
      f.handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ kind: 'committed' });
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.hydrate).toHaveBeenCalledOnce();
    expect(f.loadInputs).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamNodeOutputs: [] }),
    );
    expect(f.execute).toHaveBeenCalledWith(
      expect.objectContaining({ recordedWorkflowCallInput: value }),
    );
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
  it('records fresh required input before executor dispatch', async () => {
    const f = fixture(false);
    await f.handler.handle(delivery(), {
      signal: new AbortController().signal,
    });
    expect(f.hydrate).not.toHaveBeenCalled();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.record).toHaveBeenCalledOnce();
    expect(f.loadInputs).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamNodeOutputs: [{ nodeId: 'changed', invocationKey: 'changed' }],
      }),
    );
    expect(f.record.mock.invocationCallOrder[0]).toBeLessThan(
      f.registry.execute.mock.invocationCallOrder[0] ?? -1,
    );
  });
  it.each(['read', 'hydrate', 'prepare', 'record'] as const)(
    'propagates %s operational failure without completion or dispatch',
    async (kind) => {
      const f = fixture(kind === 'read' || kind === 'hydrate');
      const error = new Error(`${kind} failed`);
      f[kind].mockRejectedValueOnce(error);
      await expect(
        f.handler.handle(delivery(), { signal: new AbortController().signal }),
      ).rejects.toBe(error);
      expect(f.registry.execute).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    },
  );
  it('rejects a hydrated value with mismatched protected metadata', async () => {
    const f = fixture();
    f.hydrate.mockResolvedValueOnce({ name: 'different' });
    await expect(
      f.handler.handle(delivery(), { signal: new AbortController().signal }),
    ).rejects.toThrow('metadata does not match');
    expect(f.loadInputs).not.toHaveBeenCalled();
    expect(f.registry.execute).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
});
