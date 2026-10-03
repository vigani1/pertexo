import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { NodeAttemptRunStore } from '@pertexo/database/execution';
import type { PreparedNodeAttempt } from '../src/execution/node-attempt-handler.js';
import { createNodeAttemptHandler } from '../src/execution/node-attempt-handler.js';
import {
  delivery,
  executionStore,
  projection,
  registryPreparedAttempt,
  lease,
} from './support/node-attempt-handler.fixture.js';

const value = { name: 'immutable' };
const canonical = JSON.stringify(value);
const snapshot = {
  reference: { schemaVersion: 1 as const, kind: 'inline' as const, value },
  byteLength: Buffer.byteLength(canonical),
  sha256: createHash('sha256').update(canonical).digest('hex'),
  serializedValue: canonical,
};
function fixture(
  recovered = true,
  heartbeatIntervalMillis = 1_000,
  nativeProjection = false,
) {
  const heartbeat = vi
    .fn<NodeAttemptRunStore['heartbeat']>()
    .mockResolvedValue({
      abortRequested: false,
      leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
    });
  const read = vi.fn().mockResolvedValue(recovered ? snapshot : undefined);
  const record = vi.fn().mockResolvedValue(undefined);
  const loadInputs = vi.fn().mockResolvedValue({
    abortRequested: false,
    completedNodeOutputs: {},
    runInput: null,
  });
  const complete = vi.fn().mockResolvedValue({ kind: 'committed' });
  const runStore = executionStore({
    heartbeat,
    loadInputs,
    complete,
    completeCallDeclaration: complete,
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
    heartbeatIntervalMillis,
    leaseDurationSeconds: 30,
    reader: {
      close: vi.fn(),
      readForExecution: vi.fn().mockResolvedValue({
        kind: nativeProjection ? 'v3_projection' : 'v2_projection',
        workflowVersion: nativeProjection
          ? {
              ...projection(),
              schemaVersion: 2,
              executableSchemaVersion: 3,
              checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
            }
          : projection(),
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
    heartbeat,
  };
}
describe('required Call declaration input recovery orchestration', () => {
  it('does not apply the committed snapshot exception to a fresh native Call missing descriptors', async () => {
    const f = fixture(false, 1_000, true);
    await expect(
      f.handler.handle(delivery(), { signal: new AbortController().signal }),
    ).rejects.toThrow('Native input source projection is unavailable');
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.hydrate).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.registry.execute).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
  it('allows native recovery without unrelated descriptors only after committed snapshot authorization', async () => {
    const f = fixture(true, 1_000, true);
    await expect(
      f.handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ kind: 'committed' });
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.hydrate).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledWith(
      expect.objectContaining({ recordedWorkflowCallInput: value }),
    );
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
  it('uses only the committed mapped snapshot rather than hydrating unrelated native input sources', async () => {
    const f = fixture(true, 1_000, true);
    const current = lease();
    f.loadInputs.mockResolvedValueOnce({
      abortRequested: false,
      runInput: 'unhydrated source',
      completedNodeOutputs: [],
      nativeValueSources: {
        runInput: {
          slot: 'run_input',
          source: {
            kind: 'run_input',
            workspaceId: current.workspaceId,
            runId: current.runId,
            workflowVersionId: current.workflowVersionId,
            provenanceId: '77777777-7777-4777-8777-777777777777',
          },
          snapshot: {
            reference: {
              schemaVersion: 1,
              kind: 'artifact',
              artifactId: '88888888-8888-4888-8888-888888888888',
            },
            byteLength: 300_000,
            sha256: 'a'.repeat(64),
          },
        },
        completedNodeOutputs: [],
      },
    });
    await expect(
      f.handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ kind: 'committed' });
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
  it.each(['canceled', 'timed_out'] as const)(
    'refuses %s recovery before snapshot read or hydration',
    async (reason) => {
      const f = fixture();
      f.heartbeat.mockResolvedValue({
        abortRequested: true,
        abortReason: reason,
        leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
      });
      await expect(
        f.handler.handle(delivery(), { signal: new AbortController().signal }),
      ).resolves.toMatchObject({ kind: 'committed' });
      expect(f.read).not.toHaveBeenCalled();
      expect(f.hydrate).not.toHaveBeenCalled();
      expect(f.registry.execute).not.toHaveBeenCalled();
      expect(f.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: {
            status: reason,
            safeErrorCode:
              reason === 'canceled'
                ? 'execution.canceled'
                : 'execution.deadline_exceeded',
          },
        }),
      );
    },
  );
  it.each(['read', 'hydrate'] as const)(
    'keeps heartbeat ownership through snapshot %s and aborts it on lease loss',
    async (phase) => {
      const f = fixture(true, 10);
      const contextSignal = new AbortController().signal;
      const loss = new Error('Current attempt lease was lost');
      let recoverySignal: AbortSignal | undefined;
      f.heartbeat
        .mockResolvedValueOnce({
          abortRequested: false,
          leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
        })
        .mockRejectedValue(loss);
      f[phase].mockImplementation((input: { signal: AbortSignal }) => {
        recoverySignal = input.signal;
        expect(input.signal).not.toBe(contextSignal);
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      });
      await expect(
        f.handler.handle(delivery(), { signal: contextSignal }),
      ).rejects.toBe(loss);
      expect(recoverySignal?.aborted).toBe(true);
      if (recoverySignal === undefined)
        throw new Error('Recovery signal is missing');
      expect(getEventListeners(recoverySignal, 'abort')).toEqual([]);
      expect(f.heartbeat).toHaveBeenCalledTimes(2);
      expect(f.loadInputs).not.toHaveBeenCalled();
      expect(f.registry.execute).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    },
  );
  it('settles durable cancellation during recovered hydration without remapping or dispatch', async () => {
    const f = fixture(true, 10);
    f.heartbeat
      .mockResolvedValueOnce({
        abortRequested: false,
        leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
      })
      .mockResolvedValue({
        abortRequested: true,
        abortReason: 'canceled',
        leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
      });
    f.hydrate.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    await expect(
      f.handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ kind: 'committed' });
    expect(f.loadInputs).not.toHaveBeenCalled();
    expect(f.registry.execute).not.toHaveBeenCalled();
    expect(f.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: { status: 'canceled', safeErrorCode: 'execution.canceled' },
      }),
    );
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
  it('completes an artifact-backed large Call by alias without sending output through legacy completion', async () => {
    const f = fixture();
    const large = 'x'.repeat(300_000);
    const bytes = JSON.stringify(large);
    f.read.mockResolvedValue({
      reference: {
        schemaVersion: 1,
        kind: 'artifact',
        artifactId: '88888888-8888-4888-8888-888888888888',
      },
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: Buffer.byteLength(bytes),
    });
    f.hydrate.mockResolvedValue(large);
    await expect(
      f.handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ kind: 'committed' });
    expect(f.complete).toHaveBeenCalledOnce();
    const request: unknown = f.complete.mock.calls[0]?.[0];
    expect(request).toHaveProperty('lease');
    expect(request).not.toHaveProperty('outcome');
    expect(request).not.toHaveProperty('output');
    expect(request).not.toHaveProperty('reference');
  });
  it('reuses whitespace-bearing original bytes without rehashing normalized value', async () => {
    const f = fixture();
    const serializedValue = '{ "name" : "immutable" }';
    f.read.mockResolvedValue({
      ...snapshot,
      serializedValue,
      byteLength: Buffer.byteLength(serializedValue),
      sha256: createHash('sha256').update(serializedValue).digest('hex'),
    });
    await expect(
      f.handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ kind: 'committed' });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledWith(
      expect.objectContaining({ recordedWorkflowCallInput: value }),
    );
  });
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
