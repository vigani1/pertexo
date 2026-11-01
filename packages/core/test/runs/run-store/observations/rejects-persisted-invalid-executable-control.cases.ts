import { it, expect } from 'vitest';
import {
  CoordinatorRunStateCorruptError,
  asOwner,
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  seedSucceededFact,
  ownedDeliveryStore,
  versionA,
  versionB,
  workerBaseUrl,
  workflowA,
  workflowB,
  workspaceA,
  workspaceB,
} from '../fixtures.js';
import { generatePersistedId } from '@pertexo/database/platform';
import { seedAvailableArtifact } from './fixture.js';

export function registerRejectsPersistedInvalidExecutableControl(): void {
  it.each([{}, { graph: {} }])(
    'rejects persisted invalid executable control metadata %j',
    async (executableJson) => {
      const workflowVersionId = generatePersistedId();
      const checksum = `wf:sha256:${randomUUID().replaceAll('-', '').repeat(2)}`;
      await asOwner(workspaceA, (client) =>
        client.query(
          `insert into app.workflow_versions (
         id,workspace_id,workflow_id,version_number,graph_json,
         checksum,executable_json,published_by
       ) select $1,$2,workflow.id,
           (select coalesce(max(version_number),0)+1 from app.workflow_versions
             where workspace_id=$2 and workflow_id=workflow.id),'{}'::jsonb,$3,$4::jsonb,workflow.created_by
          from app.workflows workflow where workflow.workspace_id=$2 and workflow.id=$5`,
          [
            workflowVersionId,
            workspaceA,
            checksum,
            JSON.stringify(executableJson),
            workflowA,
          ],
        ),
      );
      const runId = await insertRun({ workflowVersionId });
      await expect(
        ownedDeliveryStore.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    },
  );

  it('loads a fresh artifact completion', async () => {
    const invocationKey = 'version-a/fresh-artifact';
    const artifactId = await seedAvailableArtifact();
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'fresh-artifact',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    await seedSucceededFact(runId, invocationKey, {
      kind: 'artifact',
      artifactId,
    });
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'ready',
      state: {
        observations: [
          { kind: 'outcome', output: { kind: 'artifact', artifactId } },
        ],
      },
    });
  });

  it.each(['deleting', 'deleted'] as const)(
    'fails closed when a fresh completion references a %s artifact',
    async (status) => {
      const invocationKey = `version-a/${status}-artifact`;
      const artifactId = await seedAvailableArtifact();
      const runId = await insertRun({
        schedulerState: checkpoint({
          runStatus: 'running',
          invocations: [
            {
              invocationKey,
              nodeId: `${status}-artifact`,
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        status: 'running',
      });
      await seedSucceededFact(runId, invocationKey, {
        kind: 'artifact',
        artifactId,
      });
      await asRuntime(workerBaseUrl, workspaceA, async (client) => {
        await client.query(
          `update app.artifacts set status='deleting' where id=$1`,
          [artifactId],
        );
        if (status === 'deleted')
          await client.query(
            `update app.artifacts
             set status='deleted',deleted_at=clock_timestamp() where id=$1`,
            [artifactId],
          );
      });

      await expect(
        ownedDeliveryStore.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    },
  );

  it('admits only canonical engine invocation identities', async () => {
    const runId = await insertRun({});
    const canonicalKey = `${versionA}|manual|b:|i:`;
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.node_runs (
               id,workspace_id,workflow_run_id,node_id,invocation_key,
               branch_context,status,side_effect_class
             ) values ($1,$2,$3,'manual',$4,'{}'::jsonb,'pending','safe')`,
          [randomUUID(), workspaceA, runId, canonicalKey],
        ),
      ),
    ).resolves.toBeDefined();
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.node_runs (
               id,workspace_id,workflow_run_id,node_id,invocation_key,
               branch_context,status,side_effect_class
             ) values ($1,$2,$3,'mapped',$4,'{}'::jsonb,'pending','safe')`,
          [
            randomUUID(),
            workspaceA,
            runId,
            `${versionA}|mapped|b:branch%2Fchild|i:loop%3A1`,
          ],
        ),
      ),
    ).resolves.toBeDefined();

    for (const malformed of [
      `|manual|b:|i:`,
      `${versionA}|manual|b:raw/path|i:`,
      `${versionA}|manual|b:|i:loop%3a1`,
      `${versionA}|manual|b:|i:loop:1`,
      `${versionA}|manual|b:|i:|extra`,
      `${versionA}|mánuál|b:|i:`,
    ]) {
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `insert into app.node_runs (
                 id,workspace_id,workflow_run_id,node_id,invocation_key,
                 branch_context,status,side_effect_class
               ) values ($1,$2,$3,'manual',$4,'{}'::jsonb,'pending','safe')`,
            [randomUUID(), workspaceA, runId, malformed],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('loads a valid revision-zero checkpoint at cursor two and enforces workspace RLS', async () => {
    const runId = await insertRun({});
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'ready',
      state: {
        runId,
        workflowVersionId: versionA,
        checkpoint: checkpoint({}),
        completedOutputs: [],
        observations: [],
        hasExecutionSlot: true,
        callOutcomes: [],
        taskOutcomes: [],
        workflow: expect.objectContaining({ id: versionA }) as unknown,
      },
    });
    const foreignRun = await insertRun({
      workspaceId: workspaceB,
      workflowId: workflowB,
      workflowVersionId: versionB,
      schedulerState: checkpoint({ workflowVersionId: versionB }),
    });
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId: foreignRun,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'not_found' });
  });
}
