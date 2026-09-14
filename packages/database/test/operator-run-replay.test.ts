import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CompatibilityRelease from '../src/compatibility/compatibility-release.js';

const mocks = vi.hoisted(() => ({
  acceptWorkflowRun: vi.fn(),
  classifyPublishedWorkflowVersionRow: vi.fn(),
  close: vi.fn(),
  consumeInboxMessage: vi.fn(),
  createWorkspaceDatabase: vi.fn(),
  lockExpectedCompatibilityReleaseSet: vi.fn(),
}));

vi.mock('../src/database.js', () => ({
  createWorkspaceDatabase: mocks.createWorkspaceDatabase,
}));
vi.mock('../src/execution/inbox.js', () => ({
  consumeInboxMessage: mocks.consumeInboxMessage,
}));
vi.mock('../src/execution/execution-acceptance.js', () => ({
  acceptWorkflowRun: mocks.acceptWorkflowRun,
}));
vi.mock('../src/execution/published-workflow-reader.js', () => ({
  classifyPublishedWorkflowVersionRow:
    mocks.classifyPublishedWorkflowVersionRow,
}));
vi.mock(
  '../src/compatibility/compatibility-release.js',
  async (importOriginal) => {
    const original = await importOriginal<typeof CompatibilityRelease>();
    return {
      ...original,
      lockExpectedCompatibilityReleaseSet:
        mocks.lockExpectedCompatibilityReleaseSet,
    };
  },
);

import { canonicalOutboxPayloadChecksum } from '../src/execution/outbox.js';
import {
  createOperatorRunReplayStore,
  OperatorRunReplayMismatchError,
  OperatorRunReplayNotExecutableError,
} from '../src/operator/operator-run-replay.js';
import {
  reconcileUnknownOutcomeEvidence,
  UnknownOutcomeReconciliationMismatchError,
  UnknownOutcomeReconciliationStateError,
} from '../src/execution/unknown-outcome-reconciliation.js';

const config = {
  connectionString: 'postgresql://unused.test/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 2,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;
const release = Object.freeze({
  catalogJson:
    '{"domain":"pertexo.node-compatibility-release","schemaVersion":1}',
  epoch: 1,
  fingerprint: `node-compat:v1:sha256:${'b'.repeat(64)}`,
});
const workspaceId = randomUUID();
const commandId = randomUUID();
const outboxEventId = randomUUID();
const sourceRunId = randomUUID();
const workflowId = randomUUID();
const workflowVersionId = randomUUID();
const payload = Object.freeze({
  commandId,
  outboxEventId,
  schemaVersion: 1,
  workspaceId,
});
const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
const attemptId = randomUUID();
const evidenceCommandId = randomUUID();
const evidenceOutboxEventId = randomUUID();
const evidencePayload = Object.freeze({
  attemptId,
  evidenceCommandId,
  outboxEventId: evidenceOutboxEventId,
  schemaVersion: 1,
  workspaceId,
});
const evidencePayloadChecksum = canonicalOutboxPayloadChecksum(evidencePayload);

function validResults(): { rows: Record<string, unknown>[] }[] {
  return [
    {
      rows: [
        {
          aggregate_id: commandId,
          aggregate_type: 'operator-command',
          job_name: 'replay-workflow-run',
          payload,
          payload_checksum: payloadChecksum,
          schema_version: 1,
        },
      ],
    },
    {
      rows: [
        {
          request_fingerprint: 'a'.repeat(64),
          run_input: { retained: true },
          source_run_id: sourceRunId,
          status: 'pending',
          workflow_id: workflowId,
          workflow_version_id: workflowVersionId,
        },
      ],
    },
    { rows: [{ id: workflowVersionId }] },
    { rows: [{ completed: true }] },
  ];
}

function storeWith(results = validResults()) {
  const execute = vi.fn();
  for (const result of results) execute.mockResolvedValueOnce(result);
  const transaction = { db: { execute }, workspaceId };
  const database = {
    checkCompatibility: vi.fn(),
    checkReadiness: vi.fn(),
    close: mocks.close,
    withWorkspace: vi.fn(),
  };
  mocks.createWorkspaceDatabase.mockReturnValue(database);
  mocks.consumeInboxMessage.mockImplementation(
    async (
      _database: unknown,
      _workspaceId: string,
      _delivery: unknown,
      operation: (value: typeof transaction) => Promise<unknown>,
    ) => ({ status: 'processed', value: await operation(transaction) }),
  );
  const checkpointFactory = vi.fn(() => ({
    checkpoint: { schemaVersion: 1 },
    engineVersion: 'engine-v1',
  }));
  return {
    checkpointFactory,
    database,
    execute,
    store: createOperatorRunReplayStore(config, [release], checkpointFactory),
  };
}

const replayInput = () => ({
  commandId,
  delivery: { outboxEventId, payloadChecksum },
  workspaceId,
});

function reconciliationWith(
  outboxOverride?: Record<string, unknown> | null,
  evidence: Record<string, unknown> | null = {
    status: 'outcome_unknown',
  },
) {
  const outbox = {
    aggregate_id: attemptId,
    aggregate_type: 'node-attempt',
    job_name: 'reconcile-unknown-outcome',
    payload: evidencePayload,
    payload_checksum: evidencePayloadChecksum,
    schema_version: 1,
    ...(outboxOverride ?? {}),
  };
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ rows: outboxOverride === null ? [] : [outbox] })
    .mockResolvedValueOnce({ rows: evidence === null ? [] : [evidence] });
  const transaction = { db: { execute }, workspaceId };
  const database = {
    checkCompatibility: vi.fn(),
    checkReadiness: vi.fn(),
    close: mocks.close,
    withWorkspace: vi.fn(),
  };
  mocks.consumeInboxMessage.mockImplementation(
    async (
      _database: unknown,
      _workspaceId: string,
      _delivery: unknown,
      operation: (value: typeof transaction) => Promise<unknown>,
    ) => ({ status: 'processed', value: await operation(transaction) }),
  );
  return {
    database,
    execute,
    input: {
      attemptId,
      delivery: {
        outboxEventId: evidenceOutboxEventId,
        payloadChecksum: evidencePayloadChecksum,
      },
      evidenceCommandId,
      workspaceId,
    },
  };
}

describe('operator run replay validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.close.mockResolvedValue(undefined);
    mocks.lockExpectedCompatibilityReleaseSet.mockResolvedValue(release);
    mocks.classifyPublishedWorkflowVersionRow.mockReturnValue({
      kind: 'v2_projection',
      workflowVersion: { workflowId },
    });
    mocks.acceptWorkflowRun.mockResolvedValue({ runId: randomUUID() });
  });

  it('parses compatibility expectations before creating owned database resources', () => {
    expect(() => createOperatorRunReplayStore(config, [], vi.fn())).toThrow();
    expect(mocks.createWorkspaceDatabase).not.toHaveBeenCalled();
  });

  it('validates the AbortSignal public input before entering the inbox transaction', async () => {
    const fixture = storeWith();
    await expect(
      fixture.store.replay({ ...replayInput(), signal: {} as AbortSignal }),
    ).rejects.toThrow();
    expect(mocks.consumeInboxMessage).not.toHaveBeenCalled();
  });

  it('processes exact delivery identity and forwards immutable lineage', async () => {
    const fixture = storeWith();
    const acceptedRunId = randomUUID();
    mocks.acceptWorkflowRun.mockResolvedValue({ runId: acceptedRunId });

    await expect(fixture.store.replay(replayInput())).resolves.toEqual({
      kind: 'processed',
      runId: acceptedRunId,
    });
    expect(mocks.acceptWorkflowRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        replayCommandId: commandId,
        replaySourceRunId: sourceRunId,
        runInput: { retained: true },
        workflowId,
        workflowVersionId,
      }),
    );
    expect(fixture.execute).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['missing outbox', undefined],
    ['wrong aggregate id', { aggregate_id: randomUUID() }],
    ['wrong aggregate type', { aggregate_type: 'workflow-run' }],
    ['wrong job', { job_name: 'advance-workflow-run' }],
    ['wrong schema', { schema_version: 2 }],
    ['wrong checksum', { payload_checksum: 'c'.repeat(64) }],
    [
      'wrong payload command',
      { payload: { ...payload, commandId: randomUUID() } },
    ],
    [
      'wrong payload event',
      { payload: { ...payload, outboxEventId: randomUUID() } },
    ],
    [
      'wrong payload workspace',
      { payload: { ...payload, workspaceId: randomUUID() } },
    ],
  ])('rejects %s before reading the request', async (_scenario, override) => {
    const results = validResults();
    const original = results[0]?.rows[0];
    results[0] = {
      rows:
        override === undefined || original === undefined
          ? []
          : [{ ...original, ...override }],
    };
    const fixture = storeWith(results);

    await expect(fixture.store.replay(replayInput())).rejects.toBeInstanceOf(
      OperatorRunReplayMismatchError,
    );
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(mocks.acceptWorkflowRun).not.toHaveBeenCalled();
  });

  it.each([
    ['missing request', undefined],
    ['completed request', { status: 'completed' }],
    ['failed request', { status: 'failed' }],
    ['malformed request', { request_fingerprint: 'bad' }],
  ])(
    'rejects a %s before compatibility and workflow reads',
    async (_scenario, override) => {
      const results = validResults();
      const original = results[1]?.rows[0];
      results[1] = {
        rows:
          override === undefined || original === undefined
            ? []
            : [{ ...original, ...override }],
      };
      const fixture = storeWith(results);

      await expect(fixture.store.replay(replayInput())).rejects.toBeInstanceOf(
        OperatorRunReplayMismatchError,
      );
      expect(fixture.execute).toHaveBeenCalledTimes(2);
      expect(mocks.lockExpectedCompatibilityReleaseSet).not.toHaveBeenCalled();
    },
  );

  it('rejects unavailable or workflow-mismatched V2 projection', async () => {
    const unavailable = storeWith();
    mocks.classifyPublishedWorkflowVersionRow.mockReturnValueOnce({
      kind: 'not_found',
    });
    await expect(
      unavailable.store.replay(replayInput()),
    ).rejects.toBeInstanceOf(OperatorRunReplayNotExecutableError);

    const mismatched = storeWith();
    mocks.classifyPublishedWorkflowVersionRow.mockReturnValueOnce({
      kind: 'v2_projection',
      workflowVersion: { workflowId: randomUUID() },
    });
    await expect(mismatched.store.replay(replayInput())).rejects.toBeInstanceOf(
      OperatorRunReplayNotExecutableError,
    );
  });

  it.each(['compatibility', 'checkpoint', 'acceptance', 'completion'])(
    'propagates %s failure without reporting inbox completion',
    async (phase) => {
      const failure = new Error(`${phase} failed`);
      const fixture = storeWith();
      if (phase === 'compatibility')
        mocks.lockExpectedCompatibilityReleaseSet.mockRejectedValueOnce(
          failure,
        );
      if (phase === 'checkpoint')
        fixture.checkpointFactory.mockImplementationOnce(() => {
          throw failure;
        });
      if (phase === 'acceptance')
        mocks.acceptWorkflowRun.mockRejectedValueOnce(failure);
      if (phase === 'completion') {
        const results = validResults();
        fixture.execute.mockReset();
        for (const result of results.slice(0, 3))
          fixture.execute.mockResolvedValueOnce(result);
        fixture.execute.mockRejectedValueOnce(failure);
      }

      await expect(fixture.store.replay(replayInput())).rejects.toBe(failure);
    },
  );

  it('returns duplicate without re-running durable delivery work', async () => {
    const fixture = storeWith();
    mocks.consumeInboxMessage.mockResolvedValueOnce({ status: 'duplicate' });

    await expect(fixture.store.replay(replayInput())).resolves.toEqual({
      kind: 'duplicate',
    });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(mocks.acceptWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('unknown-outcome reconciliation validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.close.mockResolvedValue(undefined);
  });

  it('processes exact evidence delivery identity and validates its public signal', async () => {
    const fixture = reconciliationWith();
    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, fixture.input),
    ).resolves.toEqual({ kind: 'processed' });
    expect(fixture.execute).toHaveBeenCalledTimes(2);

    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, {
        ...fixture.input,
        signal: {} as AbortSignal,
      }),
    ).rejects.toThrow();
    expect(mocks.consumeInboxMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing outbox', null],
    ['wrong aggregate id', { aggregate_id: randomUUID() }],
    ['wrong aggregate type', { aggregate_type: 'workflow-run' }],
    ['wrong job', { job_name: 'advance-workflow-run' }],
    ['wrong schema', { schema_version: 2 }],
    ['wrong checksum', { payload_checksum: 'c'.repeat(64) }],
    [
      'wrong payload attempt',
      { payload: { ...evidencePayload, attemptId: randomUUID() } },
    ],
    [
      'wrong payload command',
      { payload: { ...evidencePayload, evidenceCommandId: randomUUID() } },
    ],
    [
      'wrong payload event',
      { payload: { ...evidencePayload, outboxEventId: randomUUID() } },
    ],
    [
      'wrong payload workspace',
      { payload: { ...evidencePayload, workspaceId: randomUUID() } },
    ],
    ['malformed payload', { payload: { schemaVersion: 1 } }],
  ])('rejects %s before reading evidence', async (_scenario, override) => {
    const fixture = reconciliationWith(override);
    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, fixture.input),
    ).rejects.toBeInstanceOf(UnknownOutcomeReconciliationMismatchError);
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', null],
    ['no longer unknown', { status: 'succeeded' }],
  ])('rejects %s evidence state without completion', async (_scenario, row) => {
    const fixture = reconciliationWith(undefined, row);
    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, fixture.input),
    ).rejects.toBeInstanceOf(UnknownOutcomeReconciliationStateError);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
  });

  it('returns duplicate without reading durable evidence again', async () => {
    const fixture = reconciliationWith();
    mocks.consumeInboxMessage.mockResolvedValueOnce({ status: 'duplicate' });
    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, fixture.input),
    ).resolves.toEqual({ kind: 'duplicate' });
    expect(fixture.execute).not.toHaveBeenCalled();
  });
});
