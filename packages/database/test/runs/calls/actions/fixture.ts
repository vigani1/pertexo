import { Pool } from 'pg';

import { createCheckpoint } from '../../../../../workflow-engine/dist/index.js';

import { createRunAdvanceStore } from '../../../../src/runs/advance/store.js';
import { createWorkflowCallStore } from '../../../../src/runs/calls/repository.js';
import { parseDatabaseConfig } from '../../../../src/config.js';

import { admin } from '../../../lifecycle/calls/fixtures.js';
import {
  apiUrl,
  maintenanceUrl,
} from '../../../lifecycle/retention.support.js';

import { declarationFixture } from '../storage-fixtures.js';

export let runs: ReturnType<typeof createRunAdvanceStore>;

export let calls: ReturnType<typeof createWorkflowCallStore>;

export let maintenance: Pool;

export async function pending(keepExistingChild = false) {
  const fixture = await declarationFixture();
  if (!keepExistingChild)
    await admin.query('delete from app.workflow_runs where id=$1', [
      fixture.childRunId,
    ]);
  await runs.advance(
    {
      workspaceId: fixture.workspaceId,
      runId: fixture.parentRunId,
      delivery: fixture.delivery,
      signal: new AbortController().signal,
    },
    () =>
      Promise.resolve({
        kind: 'transition',
        previous: fixture.previous,
        plan: fixture.plan,
      }),
  );
  const hint = (
    await admin.query<{ id: string; payload_checksum: string }>(
      'select id,payload_checksum from app.outbox_events where aggregate_id=$1 and id<>$2',
      [fixture.parentRunId, fixture.delivery.outboxEventId],
    )
  ).rows[0];
  if (hint === undefined) throw new Error('Call wakeup missing');
  return {
    ...fixture,
    input: {
      workspaceId: fixture.workspaceId,
      runId: fixture.parentRunId,
      signal: new AbortController().signal,
      delivery: {
        outboxEventId: hint.id,
        payloadChecksum: hint.payload_checksum,
      },
    },
  };
}

export const initial: Parameters<typeof calls.performActions>[1] = (
  projection,
) => ({
  checkpoint: createCheckpoint({
    workflowVersionId: projection.id,
    iterationBudget: 200,
  }),
});

export async function outcome(parentRunId: string) {
  const row = (
    await admin.query<{
      id: string;
      status: string;
      child_run_id: string | null;
      slot_lent: boolean;
      safe_error_code: string | null;
    }>('select * from app.workflow_calls where parent_run_id=$1', [parentRunId])
  ).rows[0];
  if (row === undefined) throw new Error('Call record missing');
  return row;
}

export function beforeAllFixture1() {
  runs = createRunAdvanceStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
  );
  calls = createWorkflowCallStore(
    parseDatabaseConfig({ connectionString: maintenanceUrl, max: 1 }),
  );
  maintenance = new Pool({ connectionString: maintenanceUrl, max: 1 });
}

export async function afterAllFixture2() {
  await Promise.all([runs.close(), calls.close(), maintenance.end()]);
}
