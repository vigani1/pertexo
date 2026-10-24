import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  OperatorRunReplayMismatchError,
  OperatorRunReplayNotExecutableError,
} from '../../../src/operator/replay/repository.js';

import {
  mocks,
  commandId,
  sourceRunId,
  workflowId,
  workflowVersionId,
  payload,
  validResults,
  storeWith,
  replayInput,
} from './fixture.js';

export function registerValidatesAbortSignalPublicInputBefore(): void {
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
        startedBy: workflowId,
        runInput: { retained: true },
        workflowId,
        workflowVersionId,
      }),
    );
    expect(fixture.execute).toHaveBeenCalledTimes(5);
  });

  it.each([
    ['missing outbox', undefined],
    ['wrong aggregate id', { aggregate_id: randomUUID() }],
    ['wrong aggregate type', { aggregate_type: 'workflow-run' }],
    ['wrong job', { job_name: 'advance-workflow-run' }],
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
    },
  );

  it('rejects an unavailable or workflow-mismatched version', async () => {
    const unavailable = storeWith();
    mocks.parsePublishedWorkflowRow.mockReturnValueOnce(null);
    await expect(
      unavailable.store.replay(replayInput()),
    ).rejects.toBeInstanceOf(OperatorRunReplayNotExecutableError);

    const mismatched = storeWith();
    mocks.parsePublishedWorkflowRow.mockReturnValueOnce({
      workflowId: randomUUID(),
    });
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
}
