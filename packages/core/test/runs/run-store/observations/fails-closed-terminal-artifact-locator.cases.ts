import { it, expect } from 'vitest';
import {
  asOwner,
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  ownedDeliveryStore,
  workerBaseUrl,
  workspaceA,
  workspaceB,
} from '../fixtures.js';
import { generatePersistedId } from '@pertexo/database/platform';
import { hasConstraint } from './fixture.js';

export function registerFailsClosedTerminalArtifactLocator(): void {
  it('fails closed when a terminal artifact locator is not available in the run workspace', async () => {
    const invocationKey = 'version-a/artifact';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'artifact',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const artifactId = generatePersistedId();
    expect(artifactId[14]).toBe('7');
    await asRuntime(workerBaseUrl, workspaceB, async (client) => {
      await client.query(
        `insert into app.artifacts (
             id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at,finalized_at
           ) values ($1,$2,'node-output',$3,'application/json',1,$4,
             'available',now()+interval '1 day',now())`,
        [
          artifactId,
          workspaceB,
          `workspaces/${workspaceB}/artifacts/${artifactId}`,
          'a'.repeat(64),
        ],
      );
    });
    await expect(
      asRuntime(workerBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number
            ) values ($1,$2,$3,'artifact',$4,'{}','succeeded','safe',$5,1)`,
          [nodeRunId, workspaceA, runId, invocationKey, attemptId],
        );
        await client.query(
          `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
            ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb)`,
          [
            attemptId,
            workspaceA,
            nodeRunId,
            JSON.stringify({ kind: 'artifact', artifactId }),
          ],
        );
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('derives deadline and due observations from durable database truth', async () => {
    const invocationKey = 'version-a/waiting';
    const initialDeadlineAt = '2099-01-01T00:00:00.000Z';
    const dueAt = '2020-01-01T00:01:00.000Z';
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const runId = await insertRun({
      deadlineAt: initialDeadlineAt,
      schedulerState: checkpoint({
        runStatus: 'waiting',
        invocations: [
          {
            invocationKey,
            nodeId: 'waiting',
            status: 'waiting',
            attemptNumber: 1,
            resumeAt: dueAt,
            waitKind: 'node_wait',
          },
        ],
      }),
      status: 'waiting',
    });
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number,resume_at,wait_kind
           ) values ($1,$2,$3,'waiting',$4,'{}','waiting','safe',$5,1,$6,'node_wait')`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId, dueAt],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class
           ) values ($1,$2,$3,1,'succeeded','safe')`,
        [attemptId, workspaceA, nodeRunId],
      );
    });
    const expired = await asOwner(workspaceA, (client) =>
      client.query<{ deadline_at: Date }>(
        `update app.workflow_runs
         set created_at=clock_timestamp()-interval '2 seconds',
             deadline_at=clock_timestamp()-interval '1 second'
         where workspace_id=$1 and id=$2
         returning deadline_at`,
        [workspaceA, runId],
      ),
    );
    const deadlineAt = expired.rows[0]?.deadline_at.toISOString();
    if (deadlineAt === undefined)
      throw new Error('Controlled database deadline missing');
    const loaded = await ownedDeliveryStore.loadAdvanceState({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
    });
    expect(loaded).toMatchObject({ kind: 'ready' });
    if (loaded.kind !== 'ready') throw new Error('expected ready state');
    expect(loaded.state.observations).toEqual([
      { kind: 'deadline_expired', occurredAt: deadlineAt },
      { kind: 'due_at', invocationKey, occurredAt: dueAt },
    ]);
  });

  it('rejects nullable waiting and deadline marker shapes by exact constraint', async () => {
    const runId = await insertRun({
      schedulerState: checkpoint({ runStatus: 'running' }),
      status: 'running',
    });
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.node_runs(
            id,workspace_id,workflow_run_id,node_id,invocation_key,
            branch_context,status,side_effect_class
          ) values($1,$2,$3,'invalid-wait','invalid-wait','{}','waiting','safe')`,
          [randomUUID(), workspaceA, runId],
        ),
      ),
    ).rejects.toSatisfy(hasConstraint('node_runs_wait_state_valid'));

    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.node_runs(
            id,workspace_id,workflow_run_id,node_id,invocation_key,
            branch_context,status,side_effect_class,control_kind,due_wakeup_at
          ) values($1,$2,$3,'invalid-due','invalid-due','{}','waiting','safe',
            'for_each_barrier',clock_timestamp())`,
          [randomUUID(), workspaceA, runId],
        ),
      ),
    ).rejects.toSatisfy(hasConstraint('node_runs_due_wakeup_consistent'));

    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          'update app.workflow_runs set deadline_wakeup_at=clock_timestamp() where id=$1',
          [runId],
        ),
      ),
    ).rejects.toSatisfy(
      hasConstraint('workflow_runs_deadline_wakeup_consistent'),
    );
  });
}
