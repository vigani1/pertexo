import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { expect, it } from 'vitest';

import { readWorkflowRunReadRecord } from '../../../../src/runs/commands/records.repository.js';
import { createWorkflowRunDatabase } from '../../../../src/runs/store.js';
import {
  apiDatabase,
  apiUrl,
  workspaceA,
  workspaceCreatorId,
} from '../../../runs/acceptance/fixtures.js';
import {
  acceptRun,
  claimRuns,
  publishClaims,
  setLimit,
  transitionRun,
  withOwner,
} from '../concurrency-admission.fixtures.js';

const blockersOf = (runId: string) =>
  apiDatabase.withWorkspace(
    workspaceA,
    async (transaction) =>
      (
        await readWorkflowRunReadRecord(transaction, runId, {
          includeWorkflowName: false,
        })
      )?.admissionBlockers ?? null,
  );

/** Hold a slot for each run the queue hands out, until nothing more comes. */
async function dispatchAll(): Promise<void> {
  for (;;) {
    const batch = await claimRuns();
    if (batch.events.length === 0) return;
    await publishClaims(batch);
  }
}

async function queuedBehindALimitOfOne() {
  const workflowId = randomUUID();
  await setLimit(1, workflowId);
  const version = { workflowId, workflowVersionId: randomUUID() };
  const holding = await acceptRun(version);
  const next = await acceptRun(version);
  const behind = await acceptRun(version);
  await dispatchAll();
  return { workflowId, holding, next, behind };
}

export function registerExplainsAQueuedRun(): void {
  // The counts behind these only run for a run that may be blocked, so a page of
  // finished runs doesn't pay for them. That mustn't change what a queued one says.
  it('names what holds a queued run back, in order, at a workflow’s limit', async () => {
    const { holding, next, behind } = await queuedBehindALimitOfOne();

    // The one holding the slot still queues until a worker starts it, so it's in front.
    await expect(blockersOf(holding.runId)).resolves.toMatchObject({
      reasons: [],
    });
    await expect(blockersOf(next.runId)).resolves.toMatchObject({
      reasons: ['workflow_capacity', 'workflow_order'],
    });

    await transitionRun(holding.runId, 'running');

    await expect(blockersOf(next.runId)).resolves.toMatchObject({
      reasons: ['workflow_capacity'],
    });
    await expect(blockersOf(behind.runId)).resolves.toMatchObject({
      reasons: ['workflow_capacity', 'workflow_order'],
    });
    await transitionRun(holding.runId, 'succeeded');
    await dispatchAll();
  });

  it('explains nothing once a run isn’t waiting', async () => {
    const { holding, next, behind } = await queuedBehindALimitOfOne();

    await transitionRun(holding.runId, 'running');
    await expect(blockersOf(holding.runId)).resolves.toBeNull();

    await withOwner((client) =>
      client.query(
        `update app.workflow_runs
            set cancel_requested_at=clock_timestamp(),cancel_requested_by=$2,cancel_reason='user_requested'
          where id=$1`,
        [next.runId, workspaceCreatorId],
      ),
    );
    await expect(blockersOf(next.runId)).resolves.toBeNull();

    await withOwner((client) =>
      client.query(
        `update app.workflow_runs set created_at=clock_timestamp()-interval '2 minutes',
            deadline_at=clock_timestamp()-interval '1 minute'
          where id=$1`,
        [behind.runId],
      ),
    );
    await expect(blockersOf(behind.runId)).resolves.toBeNull();

    await transitionRun(holding.runId, 'succeeded');
    await dispatchAll();
  });

  it('says the same on a page of the list as on the run’s own page', async () => {
    const { workflowId, holding, next, behind } =
      await queuedBehindALimitOfOne();
    await withOwner((client) =>
      client.query(
        `insert into app.workspace_memberships(workspace_id,user_id,role,status)
         values($1,$2,'owner','active')
         on conflict(workspace_id,user_id) do update set role='owner',status='active'`,
        [workspaceA, workspaceCreatorId],
      ),
    );
    const runs = createWorkflowRunDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    await transitionRun(holding.runId, 'running');
    try {
      const { items } = await runs.list({
        workspaceId: workspaceA,
        actorId: workspaceCreatorId,
        limit: 10,
        workflowId,
      });
      const listed = new Map(
        items.map(({ id, admissionBlockers }) => [
          id,
          admissionBlockers?.reasons,
        ]),
      );
      expect(listed.get(holding.runId)).toBeUndefined();
      expect(listed.get(next.runId)).toEqual(['workflow_capacity']);
      expect(listed.get(behind.runId)).toEqual([
        'workflow_capacity',
        'workflow_order',
      ]);
    } finally {
      await runs.close();
    }
    await transitionRun(holding.runId, 'succeeded');
    await dispatchAll();
  });
}
