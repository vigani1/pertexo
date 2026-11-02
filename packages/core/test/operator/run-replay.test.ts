import {
  beforeEachFixture1,
  beforeEachFixture2,
  mocks,
  commandId,
  sourceRunId,
  workflowId,
  workflowVersionId,
  payload,
  validResults,
  publishedVersion,
  storeWith,
  replayInput,
  evidencePayload,
  reconciliationWith,
} from './run-replay/fixture.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  OperatorRunReplayMismatchError,
  OperatorRunReplayNotExecutableError,
} from '../../src/operator/replay/contract.js';
import {
  reconcileUnknownOutcomeEvidence,
  UnknownOutcomeReconciliationMismatchError,
  UnknownOutcomeReconciliationStateError,
} from '../../src/outbox/reconcile-unknown-outcome.js';

describe('operator run replay validation', () => {
  beforeEach(beforeEachFixture1);
  it('validates the AbortSignal public input before entering the inbox transaction', async () => {
    const fixture = storeWith();
    await expect(
      fixture.store.replay({ ...replayInput(), signal: {} as AbortSignal }),
    ).rejects.toBeInstanceOf(TypeError);
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
        startedBy: workflowId,
        runInput: { retained: true },
        workflowId,
        workflowVersionId,
      }),
    );
    expect(fixture.query).toHaveBeenCalledTimes(5);
  });

  it.each([
    ['missing outbox', undefined],
    ['wrong aggregate id', { aggregateId: randomUUID() }],
    ['wrong aggregate type', { aggregateType: 'workflow-run' }],
    ['wrong job', { jobName: 'advance-workflow-run' }],
    ['wrong checksum', { payloadChecksum: 'c'.repeat(64) }],
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
    expect(fixture.query).toHaveBeenCalledOnce();
    expect(mocks.acceptWorkflowRun).not.toHaveBeenCalled();
  });

  it.each([
    ['missing request', undefined],
    ['completed request', { status: 'completed' }],
    ['failed request', { status: 'failed' }],
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
      expect(fixture.query).toHaveBeenCalledTimes(2);
    },
  );

  it('rejects an unavailable or workflow-mismatched version', async () => {
    const unavailableResults = validResults();
    unavailableResults[2] = { rows: [] };
    const unavailable = storeWith(unavailableResults);
    await expect(
      unavailable.store.replay(replayInput()),
    ).rejects.toBeInstanceOf(OperatorRunReplayNotExecutableError);

    const mismatchedResults = validResults();
    mismatchedResults[2] = {
      rows: [{ ...publishedVersion, workflowId: randomUUID() }],
    };
    const mismatched = storeWith(mismatchedResults);
    await expect(mismatched.store.replay(replayInput())).rejects.toBeInstanceOf(
      OperatorRunReplayNotExecutableError,
    );
  });

  it.each(['checkpoint', 'acceptance', 'completion'])(
    'propagates %s failure without reporting inbox completion',
    async (phase) => {
      const failure = new Error(`${phase} failed`);
      const fixture = storeWith();
      if (phase === 'checkpoint')
        fixture.checkpointFactory.mockImplementationOnce(() => {
          throw failure;
        });
      if (phase === 'acceptance')
        mocks.acceptWorkflowRun.mockRejectedValueOnce(failure);
      if (phase === 'completion') {
        const results = validResults();
        fixture.query.mockReset();
        for (const result of results.slice(0, 3))
          fixture.query.mockResolvedValueOnce(result.rows);
        fixture.query.mockRejectedValueOnce(failure);
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
    expect(fixture.query).not.toHaveBeenCalled();
    expect(mocks.acceptWorkflowRun).not.toHaveBeenCalled();
  });
});
describe('unknown-outcome reconciliation validation', () => {
  beforeEach(beforeEachFixture2);
  it('processes exact evidence delivery identity and validates its public signal', async () => {
    const fixture = reconciliationWith();
    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, fixture.input),
    ).resolves.toEqual({ kind: 'processed' });
    expect(fixture.read).toHaveBeenCalledTimes(2);

    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, {
        ...fixture.input,
        signal: {} as AbortSignal,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(mocks.consumeInboxMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing outbox', null],
    ['wrong aggregate id', { aggregateId: randomUUID() }],
    ['wrong aggregate type', { aggregateType: 'workflow-run' }],
    ['wrong job', { jobName: 'advance-workflow-run' }],
    ['wrong checksum', { payloadChecksum: 'c'.repeat(64) }],
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
    ['malformed payload', { payload: {} }],
  ])('rejects %s before reading evidence', async (_scenario, override) => {
    const fixture = reconciliationWith(override);
    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, fixture.input),
    ).rejects.toBeInstanceOf(UnknownOutcomeReconciliationMismatchError);
    expect(fixture.read).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', null],
    ['no longer unknown', { status: 'succeeded' }],
  ])('rejects %s evidence state without completion', async (_scenario, row) => {
    const fixture = reconciliationWith(undefined, row);
    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, fixture.input),
    ).rejects.toBeInstanceOf(UnknownOutcomeReconciliationStateError);
    expect(fixture.read).toHaveBeenCalledTimes(2);
  });

  it('returns duplicate without reading durable evidence again', async () => {
    const fixture = reconciliationWith();
    mocks.consumeInboxMessage.mockResolvedValueOnce({ status: 'duplicate' });
    await expect(
      reconcileUnknownOutcomeEvidence(fixture.database, fixture.input),
    ).resolves.toEqual({ kind: 'duplicate' });
    expect(fixture.read).not.toHaveBeenCalled();
  });
});
