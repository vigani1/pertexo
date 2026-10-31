import { QUEUE_NAME } from '@pertexo/queue';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import { delay, waitForRunsToEnd } from '../../support/recovery/facts.js';
import { heldStep, startFlow } from '../../support/recovery/flows.js';
import {
  pauseQueue,
  queuedJobs,
  resumeQueue,
  waitForPublished,
} from '../../support/recovery/queues.js';
import { startStack, type Stack } from '../../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
const DELIVERY_LIMIT_MS = 30_000;

type Visible = Readonly<{
  attempt: string;
  commands: readonly string[];
  evidence: number;
  run: string;
}>;

/**
 * ADR 007: `outcome_unknown` is a terminal fact, and evidence is appended beside
 * it. The evidence is stored by the command itself; its job only checks the
 * delivery against that record. So this is the one job kind that is safe to lose:
 * losing it changes nothing anyone can see, compared with delivering it.
 */
describeFaults('the job after recording unknown-outcome evidence', () => {
  let stack: Stack;
  let jobsLeftInRedis: number;
  let afterLoss: Visible;
  let afterDelivery: Visible;
  let delivered: number;
  let runId: string;
  let attemptId: string;
  let workspace: string;

  const recordEvidence = async (): Promise<void> => {
    const command = stack.operator({
      OPERATOR_ATTEMPT_ID: attemptId,
      OPERATOR_COMMAND_ID: randomUUID(),
      OPERATOR_COMMAND_TYPE: 'unknown-outcome.record-evidence',
      OPERATOR_EVIDENCE_KIND: 'provider_receipt',
      OPERATOR_EVIDENCE_REF: '{"ticket":"INC-1"}',
      OPERATOR_WORKSPACE_ID: workspace,
    });
    command.startOnce();
    while (command.exits.length === 0) await delay(100);
    if (command.exits[0]?.code !== 0)
      throw new Error(`Evidence refused: ${JSON.stringify(command.logs)}`);
  };

  const read = async (): Promise<Visible> => {
    const [row] = await stack.sql<{
      attempt: string;
      evidence: number;
      run: string;
    }>(
      `select a.status as attempt, r.status as run,
              (select count(*)::int from app.operator_unknown_outcome_evidence e
                where e.attempt_id=a.id) as evidence
         from app.node_attempts a
         join app.node_runs n on n.id=a.node_run_id and n.workspace_id=a.workspace_id
         join app.workflow_runs r on r.id=n.workflow_run_id and r.workspace_id=n.workspace_id
        where a.id=$1`,
      [attemptId],
    );
    const commands = await stack.sql<{ status: string }>(
      `select status from app.operator_commands
        where command_type='unknown-outcome.record-evidence' order by created_at`,
    );
    if (row === undefined) throw new Error('The attempt is gone');
    return { ...row, commands: commands.map(({ status }) => status) };
  };

  const receiptsOfEvidenceJobs = async (): Promise<number> => {
    const [row] = await stack.sql<{ count: number }>(
      `select count(*)::int as count from app.inbox_receipts
        where consumer_name='unknown-outcome-reconciler' and completed_at is not null`,
    );
    return row?.count ?? 0;
  };

  beforeAll(async () => {
    stack = await startStack('unknown-outcome-evidence');
    workspace = await stack.api.createWorkspace('recovery-evidence');
    runId = await startFlow(stack, workspace, 'unknown', [
      heldStep(stack, 'unknown', 'POST'),
    ]);
    await stack.sink.waitForCalls('unknown', 1, DISPATCH_LIMIT_MS);
    await stack.worker.stop('SIGKILL');
    stack.worker.start();
    await waitForRunsToEnd(stack, [runId], RECOVERY_LIMIT_MS);
    const [attempt] = await stack.sql<{ id: string }>(
      `select a.id from app.node_attempts a
         join app.node_runs n on n.id=a.node_run_id and n.workspace_id=a.workspace_id
        where n.workflow_run_id=$1`,
      [runId],
    );
    attemptId = attempt?.id ?? '';

    await pauseQueue(stack, QUEUE_NAME.maintenance);
    await recordEvidence();
    await waitForPublished(stack, { 'reconcile-unknown-outcome': 1 });
    await stack.flushRedis();
    jobsLeftInRedis = await queuedJobs(stack, QUEUE_NAME.maintenance);
    afterLoss = await read();

    await pauseQueue(stack, QUEUE_NAME.maintenance);
    await recordEvidence();
    await waitForPublished(stack, { 'reconcile-unknown-outcome': 2 });
    await resumeQueue(stack, QUEUE_NAME.maintenance);
    const deadline = Date.now() + DELIVERY_LIMIT_MS;
    while ((await receiptsOfEvidenceJobs()) === 0 && Date.now() < deadline)
      await delay(200);
    delivered = await receiptsOfEvidenceJobs();
    afterDelivery = await read();
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('really lost one job, and delivered another', () => {
    expect(jobsLeftInRedis).toBe(0);
    expect(delivered).toBe(1);
  });

  it('keeps the evidence and the terminal fact when the job is lost', () => {
    expect(afterLoss).toEqual({
      attempt: 'outcome_unknown',
      commands: ['completed'],
      evidence: 1,
      run: 'outcome_unknown',
    });
  });

  it('shows nothing different when the job is delivered', () => {
    expect(afterDelivery).toEqual({
      attempt: 'outcome_unknown',
      commands: ['completed', 'completed'],
      evidence: 2,
      run: 'outcome_unknown',
    });
  });

  it('never sends the step again', () => {
    expect(stack.sink.calls('unknown')).toHaveLength(1);
  });
});
