import { restrictAcceptedWorkflows } from '../../../support/resources/sharing.js';

import { expect, it } from 'vitest';

import {
  accept,
  childGraph,
  fixture,
  limitWorkspace,
  parentGraph,
  publishGraph,
  runtime,
} from '../fixtures.js';

export function registerResumesTypedCallAfterWorkerRestart(): void {
  it('resumes a typed Call after worker restart and preserves one child across receipt expiry and redelivery', async () => {
    const child = await publishGraph(childGraph(1));
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            `select call.status,child.status child_status from app.workflow_calls call join app.workflow_runs child on child.workspace_id=call.workspace_id and child.id=call.child_run_id where call.parent_run_id=$1`,
            [accepted.runId],
          ),
        ).toEqual([{ status: 'accepted', child_status: 'waiting' }]);
      });
      const before = await fixture.workerQuery<{
        child_run_id: string;
        id: string;
      }>(
        'select id,child_run_id from app.workflow_calls where parent_run_id=$1',
        [accepted.runId],
      );
      expect(before).toHaveLength(1);
      const call = before[0];
      if (call === undefined) throw new Error('Accepted Call missing');
      await fixture.ownerQuery(
        'delete from app.idempotency_records where scope=$1',
        [`workflow-call:${call.id}`],
      );
      await workers.restart();
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status,output_ref from app.workflow_runs where id=$1',
            [accepted.runId],
          ),
        ).toEqual([
          {
            status: 'succeeded',
            output_ref: { kind: 'inline', value: 'Ada!' },
          },
        ]);
      });
      expect(
        await fixture.workerQuery(
          'select id,child_run_id from app.workflow_calls where parent_run_id=$1',
          [accepted.runId],
        ),
      ).toEqual(before);
      expect(
        await fixture.workerQuery(
          'select status,slot_lent,consumed_at is not null consumed from app.workflow_calls where parent_run_id=$1',
          [accepted.runId],
        ),
      ).toEqual([{ status: 'succeeded', slot_lent: false, consumed: true }]);
      expect(
        await fixture.workerQuery(
          'select workflow_run_id from app.workflow_run_active_admissions where workspace_id=$1',
          [fixture.workspaceId],
        ),
      ).toEqual([]);
    } finally {
      await workers.close();
    }
  }, 30_000);

  it('finishes an accepted published Call after its parent and child become private, without sharing child history', async () => {
    const child = await publishGraph(childGraph());
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const sharing = await restrictAcceptedWorkflows({
      ownerQuery: fixture.ownerQuery,
      workspaceId: fixture.workspaceId,
      workflowIds: [parent.workflowId, child.workflowId],
      apiUrl: fixture.databaseUrl(fixture.apiUrl),
    });
    const workers = await runtime();
    try {
      expect(await sharing.canRead(accepted.runId)).toBe(false);
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status,output_ref from app.workflow_runs where id=$1',
            [accepted.runId],
          ),
        ).toEqual([
          {
            status: 'succeeded',
            output_ref: { kind: 'inline', value: 'Ada!' },
          },
        ]);
      });
      const call = (
        await fixture.workerQuery<{ child_run_id: string }>(
          'select child_run_id from app.workflow_calls where parent_run_id=$1',
          [accepted.runId],
        )
      )[0];
      if (!call) throw new Error('Missing delegated child');
      expect(await sharing.canRead(call.child_run_id)).toBe(false);
    } finally {
      await workers.close();
      await sharing.close();
    }
  }, 30_000);

  it('passes a single workspace slot down a nested chain and returns it through each parent', async () => {
    await limitWorkspace(1);
    const leaf = await publishGraph(childGraph(1));
    const middle = await publishGraph(parentGraph(leaf.pin));
    const root = await publishGraph(parentGraph(middle.pin));
    const accepted = await accept(root);
    const workers = await runtime();
    try {
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            `select count(*)::int loans from app.workflow_calls where workspace_id=$1 and slot_lent`,
            [fixture.workspaceId],
          ),
        ).toEqual([{ loans: 2 }]);
      });
      expect(
        await fixture.workerQuery(
          `select active_runs+reserved_active_slots occupied from app.workflow_run_slot_counts($1,null,null)`,
          [fixture.workspaceId],
        ),
      ).toEqual([{ occupied: 1 }]);
      await workers.restart();
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status,output_ref from app.workflow_runs where id=$1',
            [accepted.runId],
          ),
        ).toEqual([
          {
            status: 'succeeded',
            output_ref: { kind: 'inline', value: 'Ada!' },
          },
        ]);
      });
      expect(
        await fixture.workerQuery(
          `select count(*)::int loans from app.workflow_calls where workspace_id=$1 and slot_lent`,
          [fixture.workspaceId],
        ),
      ).toEqual([{ loans: 0 }]);
    } finally {
      await workers.close();
      await limitWorkspace(5);
    }
  }, 30_000);

  it('executes five waiting parents and five children in the default five slots', async () => {
    const child = await publishGraph(childGraph(2));
    const parents = await Promise.all(
      Array.from({ length: 5 }, () => publishGraph(parentGraph(child.pin))),
    );
    const accepted = await Promise.all(parents.map((parent) => accept(parent)));
    const workers = await runtime();
    try {
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            `select count(*)::int loans from app.workflow_calls where parent_run_id=any($1::uuid[]) and slot_lent`,
            [accepted.map((run) => run.runId)],
          ),
        ).toEqual([{ loans: 5 }]);
      });
      expect(
        await fixture.workerQuery(
          `select active_runs+reserved_active_slots occupied from app.workflow_run_slot_counts($1,null,null)`,
          [fixture.workspaceId],
        ),
      ).toEqual([{ occupied: 5 }]);
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            `select count(*)::int finished from app.workflow_runs where id=any($1::uuid[]) and status='succeeded'`,
            [accepted.map((run) => run.runId)],
          ),
        ).toEqual([{ finished: 5 }]);
      });
      expect(
        await fixture.workerQuery(
          `select count(*)::int children from app.workflow_calls where parent_run_id=any($1::uuid[])`,
          [accepted.map((run) => run.runId)],
        ),
      ).toEqual([{ children: 5 }]);
    } finally {
      await workers.close();
    }
  }, 30_000);
}
