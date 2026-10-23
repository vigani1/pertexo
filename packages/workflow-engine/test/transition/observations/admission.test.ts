import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  createCheckpoint,
  executeNodeAttempt,
  invocationKey,
} from '../../../src/index.js';

import {
  standardExecutable,
  successfulRegistry,
  setAttempt,
} from '../../support/transition/operations.js';

describe('node operation risk branches', () => {
  it('deduplicates identical exact outputs and rejects conflicting evidence', async () => {
    const upstreamInvocationKey = invocationKey({
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      nodeId: 'manual',
    });
    const first = {
      invocationKey: upstreamInvocationKey,
      nodeId: 'manual',
      value: { base: 1 },
    } as const;
    const identicalRegistry = successfulRegistry();
    await expect(
      executeNodeAttempt(
        setAttempt({
          completedNodeOutputs: [first, structuredClone(first)],
          registry: identicalRegistry,
        }),
      ),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    expect(identicalRegistry.execute).toHaveBeenCalledOnce();

    for (const completedNodeOutputs of [
      [first, { ...first, value: { base: 2 } }],
      [{ ...first, value: { base: 2 } }, first],
    ]) {
      const registry = successfulRegistry();
      await expect(
        executeNodeAttempt(setAttempt({ completedNodeOutputs, registry })),
      ).rejects.toMatchObject({
        code: 'attempt_invalid',
        message: 'completed outputs conflict',
      });
      expect(registry.execute).not.toHaveBeenCalled();
    }
  });
  it('treats an empty iteration path as root attempt scope', async () => {
    const registry = successfulRegistry();
    await expect(
      executeNodeAttempt(
        setAttempt({
          invocationKey: invocationKey({
            workflowVersionId: '00000000-0000-4000-8000-000000000001',
            nodeId: 'set',
            iterationPath: [],
          }),
          iterationPath: [],
          registry,
        }),
      ),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    expect(registry.execute).toHaveBeenCalledOnce();
  });
  it('advances the complete shared persisted-fact window', async () => {
    const observations = Array.from({ length: 10_000 }, (_, index) => ({
      kind: 'cancel_requested' as const,
      sequence: index + 2,
      occurredAt: '2026-08-20T10:00:00.000Z',
    }));
    await expect(
      advanceWorkflow({
        runId: 'run-observation-window',
        executable: standardExecutable(),
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: createCheckpoint({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          iterationBudget: 100,
        }),
        observations,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 0,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ consumedThroughEventSequence: 10_001 });
  });
  it('rejects one persisted fact over the shared window limit', async () => {
    const observations = Array.from({ length: 10_001 }, (_, index) => ({
      kind: 'cancel_requested' as const,
      sequence: index + 2,
      occurredAt: '2026-08-20T10:00:00.000Z',
    }));
    await expect(
      advanceWorkflow({
        runId: 'run-observation-window',
        executable: standardExecutable(),
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: createCheckpoint({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          iterationBudget: 100,
        }),
        observations,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });
  it('admits the outer observation array without invoking caller behavior', async () => {
    const fact = {
      kind: 'cancel_requested',
      sequence: 2,
      occurredAt: '2026-08-20T10:00:00.000Z',
    } as const;
    const base = {
      runId: 'run-observation-admission',
      executable: standardExecutable(),
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: createCheckpoint({
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 100,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 0,
      signal: new AbortController().signal,
    } as const;
    let getterCalls = 0;
    const accessor = [fact];
    Object.defineProperty(accessor, '0', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return fact;
      },
    });
    const sparse: unknown[] = [];
    sparse.length = 1;
    const hidden = [fact];
    Object.defineProperty(hidden, 'hidden', { value: true });
    const symbol = [fact];
    Object.defineProperty(symbol, Symbol('hidden'), { value: true });
    const customMap = [fact];
    Object.defineProperty(customMap, 'map', {
      enumerable: true,
      value: () => {
        throw new Error('caller map executed');
      },
    });
    const customPrototype = [fact];
    Object.setPrototypeOf(customPrototype, {
      get constructor() {
        throw new Error('caller species executed');
      },
    });
    const throwingProxy = new Proxy([fact], {
      getOwnPropertyDescriptor() {
        throw new Error('caller proxy executed');
      },
    });
    const revoked = Proxy.revocable([fact], {});
    revoked.revoke();

    for (const observations of [
      accessor,
      sparse,
      hidden,
      symbol,
      customMap,
      customPrototype,
      throwingProxy,
      revoked.proxy,
    ])
      await expect(
        advanceWorkflow({ ...base, observations }),
      ).rejects.toMatchObject({
        code: 'observation_invalid',
      });
    expect(getterCalls).toBe(0);
  });
});
