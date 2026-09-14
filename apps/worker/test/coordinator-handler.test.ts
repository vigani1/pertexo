import type {
  CoordinatorRunStore,
  PublishedWorkflowReader,
  PublishedWorkflowV2Projection,
} from '@pertexo/database/testing';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/testing';
import { JOB_NAME, type QueueDelivery } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected seam fakes */

import {
  createCoordinatorHandler,
  type CoordinatorAdvanceEngine,
  CoordinatorHandlerStateError,
} from '../src/execution/coordinator-handler.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const WORKFLOW_ID = '44444444-4444-4444-8444-444444444444';
const OUTBOX_EVENT_ID = '55555555-5555-4555-8555-555555555555';
const TRACEPARENT = '00-11111111111111111111111111111111-2222222222222222-01';

function delivery(): Extract<QueueDelivery, { name: 'advance-workflow-run' }> {
  return {
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      outboxEventId: OUTBOX_EVENT_ID,
      traceparent: TRACEPARENT,
    },
    transport: { attemptsMade: 0, jobId: `outbox-${OUTBOX_EVENT_ID}` },
  };
}

function deliveryChecksum(): string {
  return canonicalOutboxPayloadChecksum(delivery().data);
}

function projection(): PublishedWorkflowV2Projection {
  return {
    id: VERSION_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 1,
    schemaVersion: 1,
    checksum:
      'wf:v2:sha256:1111111111111111111111111111111111111111111111111111111111111111',
    executableSchemaVersion: 2,
    executableJson: { schemaVersion: 2 },
    compatibilityReleaseEpoch: 1,
  };
}

function handlerFixture(
  overrides: {
    loaded?: unknown;
    published?: unknown;
    advanced?: unknown;
    committed?: unknown;
    acknowledgeFailure?: unknown;
    notificationFailure?: unknown;
  } = {},
) {
  const loadAdvanceState = vi.fn().mockResolvedValue(
    overrides.loaded ?? {
      kind: 'ready',
      state: {
        runId: RUN_ID,
        workflowVersionId: VERSION_ID,
        checkpoint: { revision: 0 },
        observations: [],
      },
    },
  );
  const readForExecution = vi.fn().mockResolvedValue(
    overrides.published ?? {
      kind: 'v2_projection',
      workflowVersion: projection(),
    },
  );
  const advance = vi.fn().mockResolvedValue(
    overrides.advanced ?? {
      kind: 'transition',
      plan: { expectedRevision: 0 },
    },
  );
  const commitAdvancePlan = vi.fn().mockResolvedValue(
    overrides.committed ?? {
      kind: 'committed',
      revision: 1,
      admittedAttempts: [],
    },
  );
  const acknowledgeAdvanceDelivery =
    overrides.acknowledgeFailure === undefined
      ? vi.fn().mockResolvedValue({ kind: 'acknowledged' })
      : vi.fn().mockRejectedValue(overrides.acknowledgeFailure);
  const resync =
    overrides.notificationFailure === undefined
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(overrides.notificationFailure);
  const handler = createCoordinatorHandler({
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
    engine: { advance },
    maximumAdmissions: 32,
    notifications: {
      close: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn(),
      resync,
    },
    reader: {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution,
    },
    runStore: {
      acknowledgeAdvanceDelivery,
      close: vi.fn().mockResolvedValue(undefined),
      commitAdvancePlan,
      loadAdvanceState,
    },
  });
  return {
    acknowledgeAdvanceDelivery,
    advance,
    commitAdvancePlan,
    handler,
    loadAdvanceState,
    readForExecution,
    resync,
  };
}

describe('coordinator handler', () => {
  it.each([
    'not_found',
    'not_executable',
    'unsupported_checkpoint',
    'capacity_exceeded',
  ] as const)('stops after a %s loaded-state result', async (kind) => {
    const selected = handlerFixture({ loaded: { kind } });
    await expect(
      selected.handler.handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: kind });
    expect(selected.readForExecution).not.toHaveBeenCalled();
    expect(selected.advance).not.toHaveBeenCalled();
    expect(selected.commitAdvancePlan).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 'workflow_not_found'],
    ['non_executable', 'workflow_non_executable'],
  ] as const)('maps published %s and does not advance', async (kind, code) => {
    const selected = handlerFixture({
      published:
        kind === 'not_found'
          ? { kind }
          : { kind, workflowVersion: projection() },
    });
    await expect(
      selected.handler.handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code });
    expect(selected.advance).not.toHaveBeenCalled();
    expect(selected.commitAdvancePlan).not.toHaveBeenCalled();
  });

  it.each([
    ['run', { runId: crypto.randomUUID(), workflowVersionId: VERSION_ID }],
    ['version', { runId: RUN_ID, workflowVersionId: crypto.randomUUID() }],
  ] as const)(
    'rejects a loaded %s identity mismatch before later work',
    async (field, identity) => {
      const selected = handlerFixture({
        loaded: {
          kind: 'ready',
          state: {
            ...identity,
            checkpoint: {},
            observations: [],
          },
        },
      });
      await expect(
        selected.handler.handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'identity_mismatch' });
      if (field === 'run')
        expect(selected.readForExecution).not.toHaveBeenCalled();
      else expect(selected.readForExecution).toHaveBeenCalledOnce();
      expect(selected.advance).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['version', { id: crypto.randomUUID(), workspaceId: WORKSPACE_ID }],
    ['workspace', { id: VERSION_ID, workspaceId: crypto.randomUUID() }],
  ] as const)(
    'rejects a published %s identity mismatch before advancement',
    async (_field, identity) => {
      const selected = handlerFixture({
        published: {
          kind: 'v2_projection',
          workflowVersion: { ...projection(), ...identity },
        },
      });
      await expect(
        selected.handler.handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'identity_mismatch' });
      expect(selected.advance).not.toHaveBeenCalled();
      expect(selected.commitAdvancePlan).not.toHaveBeenCalled();
    },
  );

  it.each(['already_committed', 'deferred', 'stale'] as const)(
    'returns a %s commit without publishing a resync hint',
    async (kind) => {
      const selected = handlerFixture({
        committed: { kind, revision: 9 },
      });
      await expect(
        selected.handler.handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind, revision: 9 });
      expect(selected.resync).not.toHaveBeenCalled();
    },
  );

  it('maps commit not-found and contains rejected post-commit notification', async () => {
    const missing = handlerFixture({ committed: { kind: 'not_found' } });
    await expect(
      missing.handler.handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'commit_not_found' });
    expect(missing.resync).not.toHaveBeenCalled();

    const notificationFailure = new Error('notification unavailable');
    const committed = handlerFixture({ notificationFailure });
    await expect(
      committed.handler.handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'committed', revision: 1 });
    expect(committed.resync).toHaveBeenCalledOnce();
  });

  it('forwards completed outputs and omits absent trace context', async () => {
    const selected = handlerFixture({
      loaded: {
        kind: 'ready',
        state: {
          runId: RUN_ID,
          workflowVersionId: VERSION_ID,
          checkpoint: {},
          observations: [],
          completedOutputs: [{ invocationKey: 'node', output: { ok: true } }],
        },
      },
    });
    const withoutTrace = delivery();
    delete (withoutTrace.data as { traceparent?: string }).traceparent;

    await expect(
      selected.handler.handle(withoutTrace, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'committed', revision: 1 });
    expect(selected.advance).toHaveBeenCalledWith(
      expect.objectContaining({
        completedOutputs: [{ invocationKey: 'node', output: { ok: true } }],
      }),
    );
    expect(selected.commitAdvancePlan.mock.calls[0]?.[0]).not.toHaveProperty(
      'traceparent',
    );
  });

  it('preserves an acknowledgement failure without attempting a commit', async () => {
    const acknowledgementFailure = new Error('acknowledgement failed');
    const selected = handlerFixture({
      advanced: { kind: 'no_change', revision: 4 },
      acknowledgeFailure: acknowledgementFailure,
    });

    await expect(
      selected.handler.handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(acknowledgementFailure);
    expect(selected.commitAdvancePlan).not.toHaveBeenCalled();
  });

  it('loads, verifies, advances, and atomically commits one delivery', async () => {
    const signal = new AbortController().signal;
    const checkpoint = { schemaVersion: 1, revision: 0 };
    const observations = [{ kind: 'cursor_only', sequence: 2 }];
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: {
        schemaVersion: 1 as const,
        engineVersion: 'phase3-engine-v1',
        workflowVersionId: VERSION_ID,
        revision: 1,
        runStatus: 'running' as const,
        nextEventSequence: 2,
        readySet: [],
        admittedInvocationKeys: [],
        invocations: [],
        joins: [],
        loops: [],
        remainingIterationBudget: 0,
        cancelRequested: false,
        deadlineExpired: false,
      },
      events: [],
      nodeRunAdmissions: [],
      attempts: [],
    };
    const runStore: CoordinatorRunStore = {
      acknowledgeAdvanceDelivery: vi.fn().mockResolvedValue({
        kind: 'acknowledged',
      }),
      close: vi.fn().mockResolvedValue(undefined),
      loadAdvanceState: vi.fn().mockResolvedValue({
        kind: 'ready',
        state: {
          runId: RUN_ID,
          workflowVersionId: VERSION_ID,
          checkpoint,
          observations,
        },
      }),
      commitAdvancePlan: vi.fn().mockResolvedValue({
        kind: 'committed',
        revision: 1,
        admittedAttempts: [],
        scheduleToStartSeconds: 4.25,
      }),
    };
    const workflowVersion = projection();
    const reader: PublishedWorkflowReader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion,
      }),
    };
    const engine: CoordinatorAdvanceEngine = {
      advance: vi.fn().mockResolvedValue({ kind: 'transition', plan }),
    };
    const resync = vi.fn().mockResolvedValue({ receivers: 1 });
    const scheduleStarted = vi.fn(() => {
      throw new Error('metrics unavailable');
    });
    const handler = createCoordinatorHandler({
      clock: { now: () => '2026-08-21T00:00:00.000Z' },
      engine,
      maximumAdmissions: 32,
      notifications: {
        close: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn(),
        resync,
      },
      reader,
      runStore,
      telemetry: { scheduleStarted },
    });

    await expect(handler.handle(delivery(), { signal })).resolves.toEqual({
      kind: 'committed',
      revision: 1,
    });
    expect(runStore.loadAdvanceState).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      signal,
    });
    expect(reader.readForExecution).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      workflowVersionId: VERSION_ID,
      signal,
    });
    expect(engine.advance).toHaveBeenCalledWith({
      checkpoint,
      maximumAdmissions: 32,
      observations,
      occurredAt: '2026-08-21T00:00:00.000Z',
      projection: workflowVersion,
      runId: RUN_ID,
      signal,
      workflowVersionId: VERSION_ID,
    });
    expect(runStore.commitAdvancePlan).toHaveBeenCalledWith({
      delivery: {
        outboxEventId: OUTBOX_EVENT_ID,
        payloadChecksum: deliveryChecksum(),
      },
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      workflowVersionId: VERSION_ID,
      plan,
      traceparent: TRACEPARENT,
      signal,
    });
    expect(resync).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
    });
    expect(scheduleStarted).toHaveBeenCalledWith(4.25);
  });

  it('fails closed when loaded persistence identity disagrees with the delivery', async () => {
    const reader: PublishedWorkflowReader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn(),
    };
    const engine: CoordinatorAdvanceEngine = { advance: vi.fn() };
    const runStore: CoordinatorRunStore = {
      acknowledgeAdvanceDelivery: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      loadAdvanceState: vi.fn().mockResolvedValue({
        kind: 'ready',
        state: {
          runId: '66666666-6666-4666-8666-666666666666',
          workflowVersionId: VERSION_ID,
          checkpoint: {},
          observations: [],
        },
      }),
      commitAdvancePlan: vi.fn(),
    };
    const handler = createCoordinatorHandler({
      clock: { now: () => '2026-08-21T00:00:00.000Z' },
      engine,
      maximumAdmissions: 32,
      reader,
      runStore,
    });

    await expect(
      handler.handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorHandlerStateError);
    await expect(
      handler.handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(reader.readForExecution).not.toHaveBeenCalled();
    expect(engine.advance).not.toHaveBeenCalled();
  });

  it('acknowledges a semantic no-op without churning the checkpoint revision', async () => {
    const commitAdvancePlan = vi.fn();
    const acknowledgeAdvanceDelivery = vi
      .fn()
      .mockResolvedValue({ kind: 'duplicate' });
    const handler = createCoordinatorHandler({
      clock: { now: () => '2026-08-21T00:00:00.000Z' },
      engine: {
        advance: vi.fn().mockResolvedValue({ kind: 'no_change', revision: 7 }),
      },
      maximumAdmissions: 32,
      reader: {
        close: vi.fn().mockResolvedValue(undefined),
        readForExecution: vi.fn().mockResolvedValue({
          kind: 'v2_projection',
          workflowVersion: projection(),
        }),
      },
      runStore: {
        acknowledgeAdvanceDelivery,
        close: vi.fn().mockResolvedValue(undefined),
        loadAdvanceState: vi.fn().mockResolvedValue({
          kind: 'ready',
          state: {
            runId: RUN_ID,
            workflowVersionId: VERSION_ID,
            checkpoint: {},
            observations: [],
          },
        }),
        commitAdvancePlan,
      },
    });

    const signal = new AbortController().signal;
    await expect(handler.handle(delivery(), { signal })).resolves.toEqual({
      kind: 'no_change',
      revision: 7,
    });
    expect(acknowledgeAdvanceDelivery).toHaveBeenCalledWith({
      delivery: {
        outboxEventId: OUTBOX_EVENT_ID,
        payloadChecksum: deliveryChecksum(),
      },
      runId: RUN_ID,
      signal,
      workspaceId: WORKSPACE_ID,
    });
    expect(commitAdvancePlan).not.toHaveBeenCalled();
  });
});
