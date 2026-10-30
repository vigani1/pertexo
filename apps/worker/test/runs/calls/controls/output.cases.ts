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
import type { createCallControlsFixture } from './fixture.js';

export function registerReturnsValidatedChildOutputThroughOrdinaryRun(
  caseFixture: ReturnType<typeof createCallControlsFixture>,
): void {
  const { activeChild, runs, settled, noLoans } = caseFixture;

  it('returns validated child output through ordinary run and step reads with a distinct origin and lineage', async () => {
    const child = await publishGraph(childGraph(1));
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      const childId = await activeChild(workers, accepted.runId);
      const pending = await runs.get({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        runId: accepted.runId,
      });
      expect(pending?.calls).toMatchObject([
        {
          childRunId: childId,
          childHistory: 'retained',
          status: 'accepted',
          slotLent: true,
        },
      ]);
      const waitingCall = pending?.nodes.find((node) => node.nodeId === 'call');
      if (waitingCall === undefined) throw new Error('Call node missing');
      expect(
        await runs.readNodeRunOutput({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          runId: accepted.runId,
          nodeRunId: waitingCall.id,
        }),
      ).toEqual({ kind: 'none' });
      const incoming = await runs.get({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        runId: childId,
      });
      expect(incoming?.run.triggerType).toBe('workflow_call');
      expect(incoming?.parentCall).toMatchObject({
        parentRunId: accepted.runId,
      });
      await settled(workers, accepted.runId, 'succeeded');
      expect(
        await runs.readNodeRunOutput({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          runId: accepted.runId,
          nodeRunId: waitingCall.id,
        }),
      ).toEqual({ kind: 'inline', value: 'Ada!' });
      const usage = await runs.statistics({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        window: '1h',
        includeWorkflows: true,
      });
      expect(
        usage.workflows?.items.find(
          (item) => item.workflowId === parent.workflowId,
        ),
      ).toMatchObject({ total: 1, byStatus: { succeeded: 1 } });
      expect(
        usage.workflows?.items.find(
          (item) => item.workflowId === child.workflowId,
        ),
      ).toMatchObject({ total: 1, byStatus: { succeeded: 1 } });
      await noLoans();
    } finally {
      await workers.close();
    }
  }, 30_000);

  it('unwinds parent cancellation down a nested chain at capacity one and never resumes the terminal parent', async () => {
    await limitWorkspace(1);
    const leaf = await publishGraph(childGraph(60));
    const middle = await publishGraph(parentGraph(leaf.pin));
    const root = await publishGraph(parentGraph(middle.pin));
    const accepted = await accept(root);
    const workers = await runtime();
    try {
      const middleId = await activeChild(workers, accepted.runId);
      const leafId = await activeChild(workers, middleId);
      await runs.cancel({
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
        runId: accepted.runId,
      });
      await settled(workers, accepted.runId, 'canceled');
      await settled(workers, middleId, 'canceled');
      await settled(workers, leafId, 'canceled');
      await workers.restart();
      await workers.until(noLoans);
      expect(
        (
          await runs.get({
            actorId: fixture.actorId,
            workspaceId: fixture.workspaceId,
            runId: accepted.runId,
          })
        )?.run.status,
      ).toBe('canceled');
    } finally {
      await workers.close();
      await limitWorkspace(5);
    }
  }, 30_000);

  it('fails a required Call when its child is canceled independently', async () => {
    const child = await publishGraph(childGraph(60));
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      const childId = await activeChild(workers, accepted.runId);
      await runs.cancel({
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
        runId: childId,
      });
      await settled(workers, childId, 'canceled');
      await settled(workers, accepted.runId, 'failed');
      const parentRun = await runs.get({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        runId: accepted.runId,
      });
      expect(
        parentRun?.nodes.find((node) => node.nodeId === 'call')?.status,
      ).toBe('failed');
      await noLoans();
    } finally {
      await workers.close();
    }
  }, 30_000);

  it('dispatches inherited deadline controls while the parent has lent its slot', async () => {
    const child = await publishGraph(childGraph(60));
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      const childId = await activeChild(workers, accepted.runId);
      const deadlines = await fixture.workerQuery<{ deadline_at: Date }>(
        'select deadline_at from app.workflow_runs where id=any($1::uuid[])',
        [[accepted.runId, childId]],
      );
      expect(deadlines).toHaveLength(2);
      expect(deadlines[0]?.deadline_at).toBeInstanceOf(Date);
      expect(deadlines[0]?.deadline_at).toEqual(deadlines[1]?.deadline_at);
      // Expire only after observing inheritance and handoff. Statement time is
      // shared by both rows and remains later than their creation timestamps.
      await fixture.ownerQuery(
        `update app.workflow_runs
         set deadline_at=statement_timestamp(),deadline_wakeup_at=null
         where workspace_id=$1 and id=any($2::uuid[])`,
        [fixture.workspaceId, [accepted.runId, childId]],
      );
      await settled(workers, accepted.runId, 'timed_out');
      // At the shared deadline, the child's own timeout and its parent's
      // close intent are ordinary competing controls; the first one settles it.
      await workers.until(async () => {
        expect(['timed_out', 'canceled']).toContain(
          (
            await runs.get({
              actorId: fixture.actorId,
              workspaceId: fixture.workspaceId,
              runId: childId,
            })
          )?.run.status,
        );
      });
      await workers.until(noLoans);
    } finally {
      await workers.close();
    }
  }, 30_000);
}
