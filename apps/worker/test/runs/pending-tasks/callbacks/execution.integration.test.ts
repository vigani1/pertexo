import { restrictAcceptedWorkflows } from '../../../support/resources/sharing.js';
import { callbackResources } from './fixtures.js';
import { randomUUID } from 'node:crypto';
import { createWorkflowAuthoringStore } from '@pertexo/core/authoring';
import {
  buildWorkflowExecutable,
  buildWorkflowTestExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { startCallbackReceiver } from './receiver.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDueNodeWakeupScanner } from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { callbackTokenHash } from '@pertexo/integrations/server';
import {
  callbackWaitConfigSchema,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  accept,
  edge,
  fixture,
  node,
  publishGraph,
  runtime,
} from '../../calls/fixtures.js';

function graph(handler = false): WorkflowGraph {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      node('manual', 'core.manual'),
      {
        ...node('wait', 'core.wait'),
        config: callbackWaitConfigSchema.parse({
          mode: 'callback',
          timeoutSeconds: 60,
        }),
      },
      {
        ...node('done', 'core.terminate'),
        inputMappings: {
          result: { kind: 'node_output', nodeId: 'wait', path: '$.body' },
        },
      },
      ...(handler ? [node('expired', 'core.terminate')] : []),
    ],
    edges: [
      edge('manual', 'wait'),
      edge('wait', 'done'),
      ...(handler ? [edge('wait', 'expired', '__failure')] : []),
    ],
  };
}

async function acceptDraft(
  version: Awaited<ReturnType<typeof publishGraph>>,
  draft: WorkflowGraph,
) {
  await fixture.ownerQuery(
    'insert into app.workflow_drafts(workspace_id,workflow_id,graph_json,updated_by) values($1,$2,$3::jsonb,$4)',
    [
      fixture.workspaceId,
      version.workflowId,
      JSON.stringify(draft),
      fixture.actorId,
    ],
  );
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  const authoring = createWorkflowAuthoringStore(
    parseDatabaseConfig({
      connectionString: fixture.databaseUrl(fixture.apiUrl),
      max: 2,
    }),
    {
      executableCompiler: (graph) => {
        const compiled = buildWorkflowExecutable({ graph, catalog });
        return {
          checksum: compiled.checksum,
          executableJson: compiled.envelope,
        };
      },
      workflowTestCompiler: (graph, pins) =>
        buildWorkflowTestExecutable({ graph, pins, catalog }),
    },
  );
  try {
    const scope = {
      workspaceId: fixture.workspaceId,
      workflowId: version.workflowId,
      actorId: fixture.actorId,
    };
    const preparation = await authoring.workflowTests.prepare(scope);
    return await authoring.workflowTests.start({
      ...scope,
      idempotencyKey: randomUUID(),
      request: {
        expectedRevision: preparation.draftRevision,
        expectedSamples: preparation.samples,
        expectedEffectfulSteps: [],
        input: {},
        acknowledgeSideEffects: false,
      },
    });
  } finally {
    await authoring.close();
  }
}

describe.runIf(fixture.enabled)('Callback waits through real workers', () => {
  beforeAll(fixture.setup, 60_000);
  afterAll(fixture.restoreServicesAndClose);
  it.each([false, true])(
    'releases its slot and pauses its clock, survives restart and consumes one response (draft test: %s)',
    async (test) => {
      const version = await publishGraph(graph());
      const run = test
        ? await acceptDraft(version, graph())
        : await accept(version);
      const { store, keys, capabilities } = callbackResources();
      const receiver = await startCallbackReceiver();
      const workers = await runtime(undefined, capabilities);
      let sharing:
        Awaited<ReturnType<typeof restrictAcceptedWorkflows>> | undefined;
      try {
        let id = '';
        await workers.until(async () => {
          const tasks = await fixture.workerQuery<{
            id: string;
            status: string;
          }>('select id,status from app.pending_run_tasks where run_id=$1', [
            run.runId,
          ]);
          expect(tasks).toHaveLength(1);
          expect(tasks[0]?.status).toBe('pending');
          id = tasks[0]?.id ?? '';
          expect(
            await fixture.workerQuery(
              'select status,human_wait_started_at is not null paused,deadline_at is not distinct from absolute_deadline_at absolute_only from app.workflow_runs where id=$1',
              [run.runId],
            ),
          ).toEqual([{ status: 'waiting', paused: true, absolute_only: true }]);
          expect(
            await fixture.workerQuery(
              'select active_runs+reserved_active_slots occupied from app.workflow_run_slot_counts($1,null,null)',
              [fixture.workspaceId],
            ),
          ).toEqual([{ occupied: 0 }]);
        });
        await workers.restart();
        const callback = await store.resolve(
          callbackTokenHash(keys.material({ id }, '1').token),
          AbortSignal.timeout(5_000),
        );
        if (callback === null) throw new Error('Missing callback');
        await workers.pause();
        if (!test) {
          sharing = await restrictAcceptedWorkflows({
            ownerQuery: fixture.ownerQuery,
            workspaceId: fixture.workspaceId,
            workflowIds: [version.workflowId],
            apiUrl: fixture.databaseUrl(fixture.apiUrl),
          });
          expect(await sharing.canRead(run.runId)).toBe(false);
        }
        const url = `${receiver.origin}/hooks/${keys.material({ id }, '1').token}/resume`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accepted: true }),
        });
        expect(response.status).toBe(202);
        const duplicate = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(duplicate.status).toBe(409);
        await workers.restart();
        await workers.until(async () => {
          expect(
            await fixture.workerQuery(
              'select status from app.workflow_runs where id=$1',
              [run.runId],
            ),
          ).toEqual([{ status: 'succeeded' }]);
        });
        expect(
          await fixture.workerQuery(
            "select output_ref from app.node_runs where workflow_run_id=$1 and node_id='done'",
            [run.runId],
          ),
        ).toEqual([
          {
            output_ref: {
              kind: 'inline',
              value: { result: { accepted: true } },
            },
          },
        ]);
        expect(
          await fixture.workerQuery(
            'select status,consumed_at is not null consumed from app.pending_run_tasks where run_id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'submitted', consumed: true }]);
      } finally {
        await workers.close();
        await sharing?.close();
        await receiver.close();
        await store.close();
        keys.close();
      }
    },
    30_000,
  );
  it('expires through the existing due scanner and takes its failure route', async () => {
    const run = await accept(await publishGraph(graph(true)));
    const { config, store, keys, capabilities } = callbackResources();
    const workers = await runtime(undefined, capabilities);
    const due = createDueNodeWakeupScanner(config);
    try {
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status from app.pending_run_tasks where run_id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'pending' }]);
      });
      await workers.pause();
      await fixture.ownerQuery(
        "update app.pending_run_tasks set opened_at=clock_timestamp()-interval '61 seconds',expires_at=clock_timestamp()-interval '1 second' where run_id=$1",
        [run.runId],
      );
      await fixture.ownerQuery(
        "update app.node_runs set resume_at=clock_timestamp()-interval '1 second' where workflow_run_id=$1 and control_kind='human_task'",
        [run.runId],
      );
      await due.claimDueWakeups(20);
      await workers.restart();
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status,handled_failure_count from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'succeeded', handled_failure_count: 1 }]);
      });
    } finally {
      await workers.close();
      await store.close();
      await due.close();
      keys.close();
    }
  }, 30_000);
});
