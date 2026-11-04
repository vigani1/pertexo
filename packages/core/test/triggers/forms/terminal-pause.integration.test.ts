import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createRunAdvanceStore } from '../../../src/runs/advance/run-advance.store.js';
import { advanceRun } from '../../../src/runs/advance/advance-run.js';
import { createWorkflowCallStore } from '../../../src/runs/calls/workflow-call.store.js';
import { createNodeAttemptRunStore } from '../../../src/attempts/node-attempt-run.store.js';
import { createWorkflowTriggerPauseFoldStore } from '../../../src/triggers/pause/fold.store.js';
import { dispatcherUrl } from '../../support/workflow-authoring.js';
import {
  config,
  fixture,
  key,
  queryAsOwner,
} from '../coordination/triggers-coordination.fixture.js';

let runs: ReturnType<typeof createRunAdvanceStore>;
let calls: ReturnType<typeof createWorkflowCallStore>;
let attempts: ReturnType<typeof createNodeAttemptRunStore>;
let fold: ReturnType<typeof createWorkflowTriggerPauseFoldStore>;
beforeAll(() => {
  runs = createRunAdvanceStore(config);
  calls = createWorkflowCallStore(config);
  attempts = createNodeAttemptRunStore(config);
  fold = createWorkflowTriggerPauseFoldStore(
    parseDatabaseConfig({ connectionString: dispatcherUrl, max: 2 }),
  );
});
afterAll(async () => {
  await Promise.all([
    runs.close(),
    calls.close(),
    attempts.close(),
    fold.close(),
  ]);
});

it('pauses after actual admitted form runs complete with failed steps', async () => {
  const f = await fixture({ mode: 'deduplicate', key, windowSeconds: 60 });
  await f.query(
    'update app.workflows set auto_pause_enabled=true,auto_pause_threshold=3 where id=$1',
    [f.workflowId],
  );
  const runIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const accepted = await f.submit(String(index));
    if (!('runId' in accepted) || accepted.runId === undefined)
      throw new Error('Form was not admitted');
    const runId = accepted.runId;
    runIds.push(runId);
    const advance = async () => {
      const [delivery] = await f.query<{
        id: string;
        payload_checksum: string;
      }>(
        `select e.id,e.payload_checksum from app.outbox_events e
         where e.aggregate_id=$1 and e.job_name='advance-workflow-run'
         and not exists(select 1 from app.inbox_receipts r where r.message_id=e.id)
         order by e.created_at limit 1`,
        [runId],
      );
      if (delivery === undefined)
        throw new Error('Coordinator delivery missing');
      return advanceRun(
        {
          runs,
          calls,
          verification: {
            catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
          },
          maximumAdmissions: 10,
        },
        {
          workspaceId: f.workspaceId,
          runId,
          signal: AbortSignal.timeout(10000),
          delivery: {
            outboxEventId: delivery.id,
            payloadChecksum: delivery.payload_checksum,
          },
        },
      );
    };
    const started = await advance();
    if (started.kind !== 'committed' || started.admittedAttempts.length !== 1)
      throw new Error('Form step was not admitted');
    const admission = started.admittedAttempts[0];
    if (admission === undefined) throw new Error('Form attempt missing');
    const [delivery] = await f.query<{ id: string; payload_checksum: string }>(
      "select id,payload_checksum from app.outbox_events where aggregate_id=$1 and job_name='execute-node-attempt'",
      [admission.attemptId],
    );
    if (delivery === undefined) throw new Error('Attempt delivery missing');
    const claimed = await attempts.claimDelivery({
      workspaceId: f.workspaceId,
      runId,
      ...admission,
      delivery: {
        outboxEventId: delivery.id,
        payloadChecksum: delivery.payload_checksum,
      },
      workerId: randomUUID(),
      leaseDurationSeconds: 30,
      signal: AbortSignal.timeout(10000),
    });
    if (claimed.kind !== 'claimed') throw new Error('Attempt lease missing');
    await attempts.complete({
      lease: claimed.lease,
      outcome: {
        status: 'failed',
        safeErrorCode: 'execution.failed',
        errorSummary: 'Step failed',
      },
      signal: AbortSignal.timeout(10000),
    });
    await advance();
  }
  expect(
    await f.query(
      'select trigger_type,status from app.workflow_runs where id=any($1::uuid[])',
      [runIds],
    ),
  ).toEqual(
    Array.from({ length: 3 }, () => ({
      trigger_type: 'form',
      status: 'failed',
    })),
  );
  expect(
    await queryAsOwner(
      'select counts_as_failure from app.workflow_trigger_outcomes where workflow_id=$1',
      [f.workflowId],
      f.workspaceId,
    ),
  ).toEqual(Array.from({ length: 3 }, () => ({ counts_as_failure: true })));
  await fold.foldPending(100);
  expect(
    await f.query(
      'select trigger_pause_state,trigger_pause_failures from app.workflows where id=$1',
      [f.workflowId],
    ),
  ).toEqual([{ trigger_pause_state: 'paused', trigger_pause_failures: 3 }]);
});
