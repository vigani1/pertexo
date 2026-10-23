import { WorkflowRunNotExecutableError } from '../../../src/runs/errors.js';
import { createWorkflowRunDatabase } from '../../../src/runs/runs.repository.js';
import { createWorkspaceDatabase } from '../../../src/database.js';
import { lockReplaySource } from '../../../src/runs/commands/replay.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  buildWorkflowTestExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { createWorkflowAuthoringDatabase } from '../../../src/authoring/workflows/database.js';
import { parseDatabaseConfig } from '../../../src/config.js';
import { createWorkflowExecutionReader } from '../../../src/runs/queries/execution/source.js';
import { createPublishedWorkflowReader } from '../../../src/runs/queries/execution/published.js';
import { IdempotencyConflictError } from '../../../src/platform/idempotency.js';
import {
  apiUrl,
  actorId,
  workspaceId,
  otherWorkspaceId,
  enforceTestRetention,
  purgeTestWorkspace,
  randomUUID,
  queryAsOwner as rawQuery,
} from '../../support/workflow-authoring.js';

const query = <T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
) => rawQuery<T>(statement, parameters, workspaceId);
const execute = async (
  statement: string,
  parameters: readonly unknown[] = [],
) => {
  await query(statement, parameters);
};
const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
let runs: ReturnType<typeof createWorkflowRunDatabase>;
let workspaceDatabase: ReturnType<typeof createWorkspaceDatabase>;
let database: ReturnType<typeof createWorkflowAuthoringDatabase>;
let reader: ReturnType<typeof createWorkflowExecutionReader>;
let publications: ReturnType<typeof createPublishedWorkflowReader>;
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
async function fixture() {
  const workflowId = randomUUID();
  const node = (id: string, key: string) => ({
    id,
    definition: { key, version: 1 },
    configVersion: 1,
    config: {},
    position: { x: 0, y: 0 },
    inputMappings: {},
    connectionRefs: {},
  });
  const graph = parseWorkflowGraphDraft({
    settings: {},
    nodes: [node('start', 'core.manual'), node('set', 'core.set')],
    edges: [
      {
        id: 'link',
        source: { nodeId: 'start', port: 'out' },
        target: { nodeId: 'set', port: 'in' },
      },
    ],
  });
  await execute(
    `insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Draft test proof',$3)`,
    [workflowId, workspaceId, actorId],
  );
  await execute(
    `insert into app.workflow_drafts(workflow_id,workspace_id,graph_json,updated_by) values($1,$2,$3::jsonb,$4)`,
    [workflowId, workspaceId, JSON.stringify(graph), actorId],
  );
  return { scope: { workflowId, workspaceId, actorId }, graph };
}
async function command(f: Awaited<ReturnType<typeof fixture>>) {
  const preparation = await database.workflowTests.prepare(f.scope);
  return {
    ...f.scope,
    idempotencyKey: randomUUID(),
    request: {
      expectedRevision: preparation.draftRevision,
      expectedSamples: preparation.samples,
      expectedEffectfulSteps: preparation.effectfulSteps.map(
        (step) => step.nodeId,
      ),
      input: { synthetic: 'test input' },
      acknowledgeSideEffects: false,
    },
  };
}

describe('whole-draft test admission', () => {
  registerFreezesUnpublishedDraftWithoutCreating();

  registerRequiresAcknowledgementExactCurrentEffectful();

  registerPurgesFrozenTestPayloadsWorkspace();
});

function registerFreezesUnpublishedDraftWithoutCreating(): void {
  it('freezes an unpublished draft without creating a publication and uses ordinary capacity', async () => {
    const f = await fixture();
    const intent = await command(f);
    const result = await database.workflowTests.start(intent);
    expect(await database.workflowTests.start(intent)).toEqual(result);
    expect(
      (
        await query<{ count: string }>(
          'select count(*) from app.workflow_versions where workflow_id=$1',
          [f.scope.workflowId],
        )
      )[0]?.count,
    ).toBe('0');
    const source = await reader.readForExecution({
      workspaceId,
      workflowVersionId: result.runId,
    });
    expect(source).toMatchObject({
      id: result.runId,
      workflowId: f.scope.workflowId,
      test: { pinnedNodeIds: [] },
    });
    expect(
      await publications.readForExecution({
        workspaceId,
        workflowVersionId: result.runId,
      }),
    ).toBeNull();
    expect(
      (await database.workflowTests.get({ ...f.scope, ...result })).graph,
    ).toEqual(f.graph);
    const rows = await query(
      'select run.trigger_type,run.started_by,run.failure_notification_destination_id,run.execution_entitlement_version,extract(epoch from (run.input_ref_expires_at-run.created_at))::integer retained_seconds from app.workflow_runs run where run.id=$1',
      [result.runId],
    );
    expect(rows[0]).toMatchObject({
      trigger_type: 'test',
      started_by: actorId,
      failure_notification_destination_id: null,
      retained_seconds: 604800,
    });
    expect(rows[0]?.execution_entitlement_version).not.toBeNull();
    await execute(
      "update app.workflow_drafts set graph_json=jsonb_set(graph_json::jsonb,'{nodes,1,label}','\"Changed later\"')::json,revision=revision+1 where workflow_id=$1",
      [f.scope.workflowId],
    );
    expect(
      (await database.workflowTests.get({ ...f.scope, ...result })).graph,
    ).toEqual(f.graph);
    expect(await database.workflowTests.start(intent)).toEqual(result);
    await expect(
      database.workflowTests.start({
        ...intent,
        request: { ...intent.request, input: { changed: true } },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('serializes two starts for the same person/workflow and preserves both command intents correctly', async () => {
    const f = await fixture();
    const first = await command(f);
    const second = { ...first, idempotencyKey: randomUUID() };
    const results = await Promise.allSettled([
      database.workflowTests.start(first),
      database.workflowTests.start(second),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toMatchObject([{ reason: { reason: 'already_running' } }]);
    expect((await database.workflowTests.list(f.scope)).items).toHaveLength(1);
  });

  it('refuses stale revisions and changed/expired pins before accepting a run', async () => {
    const f = await fixture();
    const intent = await command(f);
    await expect(
      database.workflowTests.start({
        ...intent,
        request: { ...intent.request, expectedRevision: 2 },
      }),
    ).rejects.toMatchObject({ reason: 'draft_changed' });
    await expect(
      database.workflowTests.start({
        ...intent,
        request: { ...intent.request, input: 'x'.repeat(262144) },
      }),
    ).rejects.toThrow('Stored execution value violates');
    const pin = await database.stepSamples.put({
      ...f.scope,
      nodeId: 'set',
      expectedDraftRevision: 1,
      expectedSampleId: null,
      idempotencyKey: randomUUID(),
      source: { kind: 'json', value: { pinned: 1 } },
    });
    await expect(database.workflowTests.start(intent)).rejects.toMatchObject({
      reason: 'samples_changed',
    });
    const pinnedIntent = await command(f);
    const accepted = await database.workflowTests.start(pinnedIntent);
    await database.stepSamples.remove({
      ...f.scope,
      nodeId: 'set',
      expectedDraftRevision: 1,
      expectedSampleId: pin.sampleId,
      idempotencyKey: randomUUID(),
    });
    expect(
      (
        await reader.readForExecution({
          workspaceId,
          workflowVersionId: accepted.runId,
          nodeId: 'set',
        })
      )?.testSample?.output,
    ).toEqual({ pinned: 1 });
    expect(await database.workflowTests.start(pinnedIntent)).toEqual(accepted);
    await database.stepSamples.put({
      ...f.scope,
      nodeId: 'set',
      expectedDraftRevision: 1,
      expectedSampleId: null,
      idempotencyKey: randomUUID(),
      source: { kind: 'json', value: { pinned: 2 } },
    });
    await execute(
      "update app.workflow_step_samples set created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second' where workflow_id=$1",
      [f.scope.workflowId],
    );
    await expect(database.workflowTests.prepare(f.scope)).rejects.toMatchObject(
      { reason: 'stale_sample' },
    );
  });

  it('keeps test reads workspace-bound and cancellation durable/idempotent', async () => {
    const f = await fixture();
    const accepted = await database.workflowTests.start(await command(f));
    await expect(
      reader.readForExecution({
        workspaceId: otherWorkspaceId,
        workflowVersionId: accepted.runId,
      }),
    ).resolves.toBeNull();
    await expect(
      database.workflowTests.get({
        ...f.scope,
        workspaceId: otherWorkspaceId,
        ...accepted,
      }),
    ).rejects.toThrow();
    await database.workflowTests.cancel({ ...f.scope, ...accepted });
    await database.workflowTests.cancel({ ...f.scope, ...accepted });
    const events = await query<{ type: string }>(
      'select type from app.run_events where workflow_run_id=$1 order by sequence',
      [accepted.runId],
    );
    expect(events.map((event) => event.type)).toEqual([
      'run.queued',
      'run.cancel_requested',
    ]);
    const wakeups = await query<{ count: string }>(
      "select count(*) from app.outbox_events where aggregate_id=$1 and job_name='advance-workflow-run'",
      [accepted.runId],
    );
    expect(wakeups[0]?.count).toBe('2');
  });
}

function registerRequiresAcknowledgementExactCurrentEffectful(): void {
  it('requires acknowledgement of the exact current effectful steps under the admission locks', async () => {
    const f = await fixture();
    const effectCatalog = composeExecutableCatalog({
      ...CORE_NODE_CATALOG,
      definitions: CORE_NODE_CATALOG.definitions.map((definition) =>
        definition.definition.key === 'core.set'
          ? { ...definition, retryClass: 'unsafe' as const }
          : definition,
      ),
    });
    const effects = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      {
        executableCompiler: (graph) => {
          const executable = buildWorkflowExecutable({
            graph,
            catalog: effectCatalog,
          });
          return {
            checksum: executable.checksum,
            executableJson: executable.envelope,
          };
        },
        workflowTestCompiler: (graph, pins) =>
          buildWorkflowTestExecutable({ graph, pins, catalog: effectCatalog }),
      },
    );
    try {
      const preparation = await effects.workflowTests.prepare(f.scope);
      expect(preparation.effectfulSteps).toEqual([
        { nodeId: 'set', label: 'core.set' },
      ]);
      const intent = {
        ...(await command(f)),
        request: {
          ...(await command(f)).request,
          expectedEffectfulSteps: ['set'],
        },
      };
      await expect(effects.workflowTests.start(intent)).rejects.toMatchObject({
        reason: 'effects_acknowledgement_required',
      });
      await expect(
        effects.workflowTests.start({
          ...intent,
          request: {
            ...intent.request,
            acknowledgeSideEffects: true,
            expectedEffectfulSteps: [],
          },
        }),
      ).rejects.toMatchObject({ reason: 'effects_changed' });
      expect((await effects.workflowTests.list(f.scope)).items).toEqual([]);
      const accepted = await effects.workflowTests.start({
        ...intent,
        request: { ...intent.request, acknowledgeSideEffects: true },
      });
      expect(accepted.runId).toBeTruthy();
    } finally {
      await effects.close();
    }
  });

  it('hides expired tests before maintenance and removes their frozen payloads and execution details', async () => {
    const f = await fixture();
    const accepted = await database.workflowTests.start(await command(f));
    await execute(
      `update app.workflow_runs set status='failed',created_at=clock_timestamp()-interval '8 days',completed_at=clock_timestamp()-interval '8 days',input_ref_expires_at=clock_timestamp()-interval '1 day' where id=$1`,
      [accepted.runId],
    );
    await execute(
      `update app.workflow_test_snapshots set expires_at=clock_timestamp()-interval '1 day' where id=$1`,
      [accepted.runId],
    );
    expect(
      await runs.readInput({
        actorId: actorId,
        workspaceId,
        runId: accepted.runId,
      }),
    ).toEqual({ kind: 'expired' });
    expect(
      await runs.get({ actorId: actorId, workspaceId, runId: accepted.runId }),
    ).toBeUndefined();
    expect(
      await runs.readVariables({
        actorId: actorId,
        workspaceId,
        runId: accepted.runId,
      }),
    ).toBeNull();
    expect((await database.workflowTests.list(f.scope)).items).toEqual([]);
    await expect(
      database.workflowTests.get({ ...f.scope, ...accepted }),
    ).rejects.toMatchObject({ reason: 'not_found' });
    // Private workers retain the execution source until they can settle interrupted tests.
    expect(
      await reader.readForExecution({
        workspaceId,
        workflowVersionId: accepted.runId,
      }),
    ).not.toBeNull();
    const removed = await enforceTestRetention(2);
    expect(removed.workflow_test_snapshots).toBe(1);
    expect(
      await reader.readForExecution({
        workspaceId,
        workflowVersionId: accepted.runId,
      }),
    ).toBeNull();
    expect(
      (
        await query<{ count: string }>(
          'select count(*) from app.run_checkpoints where workflow_run_id=$1',
          [accepted.runId],
        )
      )[0]?.count,
    ).toBe('0');
    expect(
      (
        await query<{ input_ref: unknown }>(
          'select input_ref from app.workflow_runs where id=$1',
          [accepted.runId],
        )
      )[0]?.input_ref ?? null,
    ).toBeNull();
  });

  it('refuses a draft test as the source of published replay or recovery', async () => {
    const f = await fixture();
    const accepted = await database.workflowTests.start(await command(f));
    await expect(
      workspaceDatabase.withWorkspace(workspaceId, (transaction) =>
        lockReplaySource(transaction, accepted.runId),
      ),
    ).rejects.toBeInstanceOf(WorkflowRunNotExecutableError);
  });

  it('uses the existing queued-run quota and rolls back a refused test atomically', async () => {
    const f = await fixture();
    const intent = await command(f);
    const previous = (
      await query<{ current_version: number }>(
        'select current_version from app.workspace_execution_entitlements where workspace_id=$1',
        [workspaceId],
      )
    )[0];
    if (previous === undefined)
      throw new Error('Expected workspace entitlement');
    await execute(
      `insert into app.workspace_execution_entitlement_versions(workspace_id,version,status,active_run_limit,queued_run_limit) select workspace_id,version+1,status,active_run_limit,1 from app.workspace_execution_entitlement_versions where workspace_id=$1 and version=$2`,
      [workspaceId, previous.current_version],
    );
    await execute(
      'update app.workspace_execution_entitlements set current_version=current_version+1 where workspace_id=$1',
      [workspaceId],
    );
    try {
      await expect(database.workflowTests.start(intent)).rejects.toThrow(
        'workspace.quota_exceeded',
      );
      expect((await database.workflowTests.list(f.scope)).items).toEqual([]);
    } finally {
      await execute(
        'update app.workspace_execution_entitlements set current_version=$2 where workspace_id=$1',
        [workspaceId, previous.current_version],
      );
    }
  });

  it('freezes dense numeric pins without JSONB expansion and reads back their exact value', async () => {
    const f = await fixture();
    const output = { values: Array.from({ length: 9990 }, () => 1e300) };
    await database.stepSamples.put({
      ...f.scope,
      nodeId: 'set',
      expectedDraftRevision: 1,
      expectedSampleId: null,
      idempotencyKey: randomUUID(),
      source: { kind: 'json', value: output },
    });
    const accepted = await database.workflowTests.start(await command(f));
    const stored = (
      await query<{ bytes: number }>(
        'select octet_length(pins::text) bytes from app.workflow_test_snapshots where id=$1',
        [accepted.runId],
      )
    )[0];
    expect(stored?.bytes).toBeLessThanOrEqual(2 * 262144);
    expect(
      (
        await reader.readForExecution({
          workspaceId,
          workflowVersionId: accepted.runId,
          nodeId: 'set',
        })
      )?.testSample?.output,
    ).toEqual(output);
  });
}

function registerPurgesFrozenTestPayloadsWorkspace(): void {
  it('purges frozen test payloads with their workspace through maintenance', async () => {
    expect(
      (
        await query<{ count: string }>(
          'select count(*) from app.workflow_test_snapshots where workspace_id=$1',
          [workspaceId],
        )
      )[0]?.count,
    ).not.toBe('0');
    const steps = await purgeTestWorkspace(workspaceId, { pageSize: 2 });
    expect(steps).toContain('workflow_test_snapshots');
    expect(
      await query(
        'select id from app.workflow_test_snapshots where workspace_id=$1',
        [workspaceId],
      ),
    ).toEqual([]);
    expect(
      await query('select id from app.workflow_runs where workspace_id=$1', [
        workspaceId,
      ]),
    ).toEqual([]);
  });
}

function beforeAllFixture1() {
  const config = parseDatabaseConfig({ connectionString: apiUrl, max: 4 });
  runs = createWorkflowRunDatabase(config);
  workspaceDatabase = createWorkspaceDatabase(config);
  database = createWorkflowAuthoringDatabase(config, {
    executableCompiler: (graph) => {
      const executable = buildWorkflowExecutable({ graph, catalog });
      return {
        checksum: executable.checksum,
        executableJson: executable.envelope,
      };
    },
    workflowTestCompiler: (graph, pins) =>
      buildWorkflowTestExecutable({ graph, pins, catalog }),
  });
  reader = createWorkflowExecutionReader(config);
  publications = createPublishedWorkflowReader(config);
}

async function afterAllFixture2() {
  await Promise.all([
    database.close(),
    reader.close(),
    publications.close(),
    runs.close(),
    workspaceDatabase.close(),
  ]);
}
