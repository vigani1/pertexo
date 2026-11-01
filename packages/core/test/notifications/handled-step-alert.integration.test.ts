import { settleCallableResult } from '@pertexo/workflow-engine';
import { FailureNotificationContextSchema } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';

import {
  OCCURRED_AT,
  failStep,
  pinnedAlert,
  signal,
  startEngineRun,
  succeedStep,
} from './handled-step.support.js';
import {
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  rawStore,
  testDelivery,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../runs/run-store/fixtures.js';

async function storedAlerts(runId: string) {
  const { rows } = await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query<{ context: unknown; status: string }>(
      `select context,status from app.run_failure_notification_intents
        where workflow_run_id=$1`,
      [runId],
    ),
  );
  return rows;
}

async function storedAlertContext(runId: string) {
  const alerts = await storedAlerts(runId);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.status).toBe('pending');
  return FailureNotificationContextSchema.parse(alerts[0]?.context);
}

describe('the alert for a failed run with a handled step', () => {
  // The way a real graph gets here: failure links need a tree with no fan-out,
  // so a handled step ends its run, which then fails only on a callable's result.
  it('names no step when the handled step was the only failure', async () => {
    const { runId, decide, save } = await startEngineRun();
    let plan = await save(await decide());
    await succeedStep(runId, plan, 'manual');
    plan = await save(await decide());
    await failStep(runId, 'source');
    plan = await save(await decide());
    await succeedStep(runId, plan, 'handler');
    plan = await save(await decide());
    expect(await storedAlerts(runId)).toEqual([]);
    await succeedStep(runId, plan, 'handler-stop');

    const provisional = await decide();
    expect(provisional.checkpoint.runStatus).toBe('succeeded');
    expect(
      provisional.checkpoint.invocations.find(
        ({ nodeId }) => nodeId === 'source',
      )?.failureHandling?.disposition,
    ).toBe('handled');
    await save(
      settleCallableResult(provisional, {
        kind: 'invalid',
        reasonCode: 'callable_result_missing',
      }),
    );

    expect(await storedAlertContext(runId)).toMatchObject({
      terminalStatus: 'failed',
      totalFailureCount: 1,
      primaryFailure: {
        source: 'run',
        runStatus: 'failed',
        safeErrorCode: 'callable_result_missing',
      },
    });
  });

  // `a-handled` sorts first, so counting it would name it ahead of `z-failed`.
  it('names and counts only the step that really failed, when one did', async () => {
    const handledKey = `failure/a-handled/${randomUUID()}`;
    const failedKey = `failure/z-failed/${randomUUID()}`;
    const handledSink = `failure/handler/${randomUUID()}`;
    const handled = {
      invocationKey: handledKey,
      nodeId: 'a-handled',
      status: 'failed',
      attemptNumber: 1,
      failureHandling: {
        sinkInvocationKey: handledSink,
        disposition: 'handled',
      },
    };
    const runId = await insertRun({
      status: 'running',
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          handled,
          {
            invocationKey: failedKey,
            nodeId: 'z-failed',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      failureNotificationPolicy: pinnedAlert,
    });
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      const handledAttempt = randomUUID();
      const handledRun = randomUUID();
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number,safe_error_code
         ) values ($1,$2,$3,'a-handled',$4,'{}','failed','safe',$5,1,'handled.failure')`,
        [handledRun, workspaceA, runId, handledKey, handledAttempt],
      );
      const failedAttempt = randomUUID();
      const failedRun = randomUUID();
      await client.query(
        `insert into app.node_runs (
           id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,current_attempt_id,current_attempt_number
         ) values ($1,$2,$3,'z-failed',$4,'{}','running','safe',$5,1)`,
        [failedRun, workspaceA, runId, failedKey, failedAttempt],
      );
      for (const [attemptId, nodeRunId, code, decision] of [
        [handledAttempt, handledRun, 'handled.failure', 'failed'],
        [failedAttempt, failedRun, 'provider.unavailable', 'pending'],
      ] as const)
        await client.query(
          `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
             safe_error_code,executor_failure_kind,executor_error_kind,
             executor_possibly_dispatched,retry_decision
           ) values ($1,$2,$3,1,'failed','safe',$4,'failed','provider',false,$5)`,
          [attemptId, workspaceA, nodeRunId, code, decision],
        );
    });

    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: signal(),
        delivery: await testDelivery(workspaceA, runId, 0),
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'failed',
            nextEventSequence: 4,
            invocations: [
              handled,
              {
                invocationKey: failedKey,
                nodeId: 'z-failed',
                status: 'failed',
                attemptNumber: 1,
              },
            ],
          }),
          events: [
            {
              sequence: 2,
              name: 'node.failed',
              occurredAt: OCCURRED_AT,
              invocationKey: failedKey,
              nodeId: 'z-failed',
              attemptNumber: 1,
              reasonCode: 'provider.unavailable',
            },
            { sequence: 3, name: 'run.failed', occurredAt: OCCURRED_AT },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed' });

    expect(await storedAlertContext(runId)).toMatchObject({
      terminalStatus: 'failed',
      totalFailureCount: 1,
      primaryFailure: {
        nodeId: 'z-failed',
        invocationKey: failedKey,
        nodeStatus: 'failed',
        safeErrorCode: 'provider.unavailable',
      },
    });
  });
});
