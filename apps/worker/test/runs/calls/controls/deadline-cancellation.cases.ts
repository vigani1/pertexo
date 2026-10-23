import { randomUUID } from 'node:crypto';
import {
  createNodeRegistry,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  CORE_NODE_DEFINITION_REGISTRATIONS,
  CORE_NODE_EXECUTOR_REGISTRATIONS,
} from '@pertexo/nodes-core/server';

import { expect, it } from 'vitest';
import {
  accept,
  childGraph,
  fixture,
  node,
  edge,
  parentGraph,
  publishGraph,
  runtime,
} from '../fixtures.js';
import type { createCallControlsFixture } from './fixture.js';

export function registerNarrowsRecordedChildDeadlineFailsRequiredCall(
  caseFixture: ReturnType<typeof createCallControlsFixture>,
): void {
  const { activeChild, settled, runs, noLoans } = caseFixture;

  it('narrows the recorded child deadline and fails the required Call when the child times out first', async () => {
    const child = await publishGraph(childGraph(60));
    const parent = await publishGraph({
      ...parentGraph(child.pin),
      settings: { maxRunDurationMs: 120_000 },
    });
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      const childId = await activeChild(workers, accepted.runId);
      expect(
        await fixture.workerQuery(
          `select child.deadline_at < parent.deadline_at as narrowed
           from app.workflow_runs child
           join app.workflow_runs parent on parent.workspace_id=child.workspace_id
           where child.workspace_id=$1 and child.id=$2 and parent.id=$3`,
          [fixture.workspaceId, childId, accepted.runId],
        ),
      ).toEqual([{ narrowed: true }]);
      await fixture.ownerQuery(
        `update app.workflow_runs
         set deadline_at=statement_timestamp(),deadline_wakeup_at=null
         where workspace_id=$1 and id=$2`,
        [fixture.workspaceId, childId],
      );
      await settled(workers, childId, 'timed_out');
      await settled(workers, accepted.runId, 'failed');
      expect(
        (
          await runs.get({
            actorId: fixture.actorId,
            workspaceId: fixture.workspaceId,
            runId: accepted.runId,
          })
        )?.calls,
      ).toMatchObject([{ status: 'timed_out', slotLent: false }]);
      await noLoans();
    } finally {
      await workers.close();
    }
  }, 30_000);

  it('continues an accepted child after its workflow is archived and the starting member is revoked', async () => {
    const readerId = randomUUID();
    await fixture.ownerQuery(
      "insert into app.users(id,email,display_name) values($1,$2,'Retained run reader')",
      [readerId, `${readerId}@example.test`],
    );
    await fixture.ownerQuery(
      "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'viewer')",
      [fixture.workspaceId, readerId],
    );

    const child = await publishGraph(childGraph(2));
    const parent = await publishGraph(parentGraph(child.pin));
    await fixture.ownerQuery(
      "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'owner') on conflict do nothing",
      [fixture.workspaceId, fixture.actorId],
    );
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      await activeChild(workers, accepted.runId);
      await fixture.ownerQuery(
        "update app.workflows set lifecycle_status='archived',lifecycle_revision=lifecycle_revision+1 where workspace_id=$1 and id=$2",
        [fixture.workspaceId, child.workflowId],
      );
      expect(
        await fixture.ownerQuery(
          'delete from app.workspace_memberships where workspace_id=$1 and user_id=$2 returning user_id',
          [fixture.workspaceId, fixture.actorId],
        ),
      ).toEqual([{ user_id: fixture.actorId }]);
      await workers.restart();
      expect(
        await runs.get({
          workspaceId: fixture.workspaceId,
          actorId: fixture.actorId,
          runId: accepted.runId,
        }),
      ).toBeUndefined();
      await settled(workers, accepted.runId, 'succeeded', readerId);
      await noLoans();
    } finally {
      await workers.close();
      await fixture.ownerQuery(
        "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'owner') on conflict do nothing",
        [fixture.workspaceId, fixture.actorId],
      );
    }
  }, 30_000);

  it('fails the parent on an invalid child result rather than exposing its prepared Call input', async () => {
    const value = childGraph();
    if (value.callable === undefined) throw new Error('Child contract missing');
    const child = await publishGraph({
      ...value,
      callable: { ...value.callable, resultType: { type: 'number' } },
    });
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      await settled(workers, accepted.runId, 'failed');
      expect(
        (
          await runs.get({
            actorId: fixture.actorId,
            workspaceId: fixture.workspaceId,
            runId: accepted.runId,
          })
        )?.calls,
      ).toMatchObject([
        { status: 'failed', safeErrorCode: 'callable_result_invalid' },
      ]);
      await noLoans();
    } finally {
      await workers.close();
    }
  }, 30_000);

  it('keeps an unknown child outcome unknown through restart without rewriting the terminal parent', async () => {
    const registry = createNodeRegistry({
      catalog: CORE_NODE_CATALOG,
      definitions: CORE_NODE_DEFINITION_REGISTRATIONS,
      executors: CORE_NODE_EXECUTOR_REGISTRATIONS.map((registration) =>
        registration.executor.key !== 'core.set'
          ? registration
          : {
              ...registration,
              execute: () =>
                Promise.reject(
                  new NodeExecutorFailure({
                    kind: 'outcome_unknown',
                    errorKind: 'network',
                    possiblyDispatched: true,
                  }),
                ),
            },
      ),
    });
    const value = childGraph();
    const child = await publishGraph({
      ...value,
      nodes: [
        node('manual', 'core.manual'),
        node('uncertain', 'core.set'),
        node('finish', 'core.terminate'),
      ],
      edges: [edge('manual', 'uncertain'), edge('uncertain', 'finish')],
    });
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime(registry);
    try {
      await settled(workers, accepted.runId, 'outcome_unknown');
      const saved = await runs.get({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        runId: accepted.runId,
      });
      expect(saved?.calls).toMatchObject([
        { status: 'outcome_unknown', slotLent: false },
      ]);
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
      ).toBe('outcome_unknown');
    } finally {
      await workers.close();
    }
  }, 30_000);
}
