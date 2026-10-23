import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
} from '../../../src/index.js';
import { providerIdempotencyKey } from '../../support/engine.js';
import { graph, nodeCatalog } from '../../support/executable-workflow.js';
describe('attempt outcome production operations', () => {
  it('rejects a non-array completed-output boundary before derivation', async () => {
    const executable = buildWorkflowExecutable({
      graph: graph(),
      catalog: composeExecutableCatalog(nodeCatalog()),
    });
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: createCheckpoint({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          iterationBudget: 0,
        }),
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        completedOutputs: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });
  it('carries exact pinned side-effect classes into attempt admissions', async () => {
    const catalog = composeExecutableCatalog(
      nodeCatalog({
        manualRetryClass: 'unsafe',
        setRetryClass: 'idempotent-with-key',
      }),
    );
    const executable = buildWorkflowExecutable({ graph: graph(), catalog });
    const checkpoint = createCheckpoint({
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      iterationBudget: 0,
    });
    const manual = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint,
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manualAttempt = manual.attempts[0];
    if (manualAttempt === undefined) throw new Error('manual was not admitted');
    expect(manualAttempt).toMatchObject({
      nodeId: 'manual',
      sideEffectClass: 'unsafe',
    });
    const completedManual = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: manual.checkpoint,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          sequence: manual.checkpoint.nextEventSequence,
          occurredAt: '2026-08-20T10:01:00.000Z',
          attemptId: '00000000-0000-4000-8000-000000000011',
          attemptNumber: manualAttempt.attemptNumber,
          kind: 'outcome',
          invocationKey: manualAttempt.invocationKey,
          status: 'succeeded',
        },
      ],
      signal: new AbortController().signal,
    });
    const setAttempt = completedManual.attempts[0];
    if (setAttempt === undefined) throw new Error('set was not admitted');
    const expectedProviderKey = providerIdempotencyKey({
      invocationKey: setAttempt.invocationKey,
      namespace: 'pertexo.node-attempt',
      operationIdentity: 'core.set@1',
      runId: 'run-1',
    });
    expect(setAttempt).toMatchObject({
      nodeId: 'set',
      providerIdempotencyKey: expectedProviderKey,
      sideEffectClass: 'idempotent_with_key',
    });
    expect(
      completedManual.nodeRunAdmissions.find(({ nodeId }) => nodeId === 'set'),
    ).toMatchObject({ providerIdempotencyKey: expectedProviderKey });
  });
  it('assigns the same provider key before capacity admission', async () => {
    const executable = buildWorkflowExecutable({
      graph: graph(),
      catalog: composeExecutableCatalog(
        nodeCatalog({ manualRetryClass: 'idempotent-with-key' }),
      ),
    });
    const input = {
      runId: 'capacity-run',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      occurredAt: '2026-08-20T10:00:00.000Z',
      observations: [],
      signal: new AbortController().signal,
    } as const;
    const materialized = await advanceWorkflow({
      ...input,
      checkpoint: createCheckpoint({
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 0,
      }),
      maximumAdmissions: 0,
    });
    const admitted = await advanceWorkflow({
      ...input,
      checkpoint: materialized.checkpoint,
      maximumAdmissions: 1,
    });
    expect(materialized.nodeRunAdmissions).toHaveLength(1);
    expect(admitted.attempts).toHaveLength(1);
    const materializedKey =
      materialized.nodeRunAdmissions[0]?.providerIdempotencyKey;
    const admittedKey = admitted.attempts[0]?.providerIdempotencyKey;
    expect(materializedKey).toBeTruthy();
    expect(admittedKey).toBeTruthy();
    expect(materializedKey).toBe(
      providerIdempotencyKey({
        invocationKey: '00000000-0000-4000-8000-000000000001|manual|b:|i:',
        namespace: 'pertexo.node-attempt',
        operationIdentity: 'core.manual@1',
        runId: 'capacity-run',
      }),
    );
    expect(admittedKey).toBe(materializedKey);
  });
  it.each([undefined, 30_000])(
    'resolves typed attempt failure into one coordinator retry transition (hint %s)',
    async (minimumRetryDelayMillis) => {
      const executable = buildWorkflowExecutable({
        graph: graph(),
        catalog: composeExecutableCatalog(nodeCatalog()),
      });
      const started = await advanceWorkflow({
        runId: 'retry-run',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: createCheckpoint({
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          iterationBudget: 0,
        }),
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      });
      const attempt = started.attempts[0];
      if (attempt === undefined) throw new Error('attempt was not admitted');

      const retried = await advanceWorkflow({
        runId: 'retry-run',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: started.checkpoint,
        occurredAt: '2026-08-20T10:01:00.000Z',
        maximumAdmissions: 1,
        observations: [
          {
            kind: 'attempt_failure',
            occurredAt: '2026-08-20T10:00:30.000Z',
            invocationKey: attempt.invocationKey,
            attemptId: '00000000-0000-4000-8000-000000000099',
            attemptNumber: attempt.attemptNumber,
            failureKind: 'retry',
            errorKind: 'rate_limit',
            possiblyDispatched: false,
            safeErrorCode: 'execution.rate_limit',
            ...(minimumRetryDelayMillis === undefined
              ? {}
              : { minimumRetryDelayMillis }),
          },
        ],
        signal: new AbortController().signal,
      });

      const scheduled = retried.events.find(
        ({ name }) => name === 'node.retry_scheduled',
      );
      expect(scheduled?.dueAt).toBe(
        minimumRetryDelayMillis === undefined
          ? '2026-08-20T10:00:31.200Z'
          : '2026-08-20T10:01:00.000Z',
      );
      expect(retried.attempts).toEqual([]);
      expect(retried.checkpoint.invocations[0]).toMatchObject({
        status: 'waiting',
        resumeAt: scheduled?.dueAt,
        attemptNumber: 1,
      });
    },
  );
  it('preserves a definite executor cancellation as canceled', async () => {
    const executable = buildWorkflowExecutable({
      graph: graph(),
      catalog: composeExecutableCatalog(nodeCatalog()),
    });
    const started = await advanceWorkflow({
      runId: 'canceled-attempt-run',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: createCheckpoint({
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const attempt = started.attempts[0];
    if (attempt === undefined) throw new Error('attempt was not admitted');

    const canceled = await advanceWorkflow({
      runId: 'canceled-attempt-run',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: '2026-08-20T10:00:30.000Z',
          invocationKey: attempt.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000098',
          attemptNumber: attempt.attemptNumber,
          failureKind: 'canceled',
          errorKind: 'canceled',
          possiblyDispatched: false,
          safeErrorCode: 'execution.canceled',
        },
      ],
      signal: new AbortController().signal,
    });

    expect(canceled.events.map(({ name }) => name)).toContain('node.canceled');
    expect(canceled.checkpoint.invocations[0]).toMatchObject({
      status: 'canceled',
    });
  });
});
