import { requireConnectionBindings } from '../../tenant-access/resources/connections/bindings.js';
import { requireWorkflowCallTargets } from '../../tenant-access/resources/bindings.js';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  canonicalJson,
  DEFAULT_TEST_EXPECTATIONS,
  type WorkflowTestExpectations,
} from '@pertexo/workflow-model';
import type { WorkflowTestSuitePreparation } from '@pertexo/contracts';
import { databaseSchema } from '../../schema.js';
import { parseWorkspaceId } from '../../tenant-access/transactions.js';
import { captureWorkspaceVariableRevision } from '../../variables/settings.queries.js';
import { lockInputCaseQuota } from '../../authoring/input-cases/store.js';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import { lockArtifactReferences } from '../../artifacts/references/repository.js';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { cancelInTransaction } from '../../runs/runs.repository.js';
import { TEST_RUN_RETENTION_MILLIS } from '../../runs/data-policy.js';
import { WorkflowTestError } from '../workflows/contract.js';
import { withTestAuthority, withTestRead } from '../workflows/authority.js';
import {
  requireNoActiveSuite,
  requireNoActiveTest,
} from '../workflows/admit.js';
import {
  loadTestSnapshot,
  saveTestSnapshot,
  sameTestSamples,
} from '../workflows/snapshot.js';
import type { AuthoringCatalogs } from '../../authoring/workflows/catalogs.js';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import type {
  WorkflowTestSuiteStore,
  SuiteRow,
  SuiteCaseRow,
} from './contract.js';
import { readSuiteCurrent } from './current.js';
import { listSuites, readSuite, readCaseReport } from './read.js';
import { admitSuiteCase } from './admit.js';

export function createWorkflowTestSuiteStore(
  pool: Pool,
  catalogs: AuthoringCatalogs,
): WorkflowTestSuiteStore {
  return {
    prepare: (input) => prepareTestSuite(pool, catalogs, input),
    start: (input) => startTestSuite(pool, catalogs, input),
    list: (input) =>
      withTestRead(pool, input, async (client) => ({
        current: await readSuiteCurrent(client, input),
        items: await listSuites(client, input),
      })),
    get: (input) =>
      withTestRead(pool, input, (client) => readSuite(client, input)),
    report: (input) =>
      withTestRead(pool, input, (client) => readCaseReport(client, input)),
    cancel: (input) =>
      withTestAuthority(pool, input, async (client) => {
        await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
          actorId: input.actorId,
          roles: rolesForCapability('run:cancel'),
        });
        const found = await client.query<SuiteRow>(
          'select * from app.workflow_test_suites where workspace_id=$1 and workflow_id=$2 and id=$3 and expires_at>clock_timestamp() for update',
          [input.workspaceId, input.workflowId, input.suiteId],
        );
        const suite = found.rows[0];
        if (suite === undefined) throw new WorkflowTestError('not_found');
        if (suite.status !== 'running') return;
        await client.query(
          "update app.workflow_test_suites set cancel_requested=true,stop_reason='user_canceled',next_check_at=clock_timestamp() where workspace_id=$1 and id=$2",
          [input.workspaceId, input.suiteId],
        );
        await client.query(
          "update app.workflow_test_suite_cases set status='skipped' where workspace_id=$1 and suite_id=$2 and status='pending'",
          [input.workspaceId, input.suiteId],
        );
        const active = await client.query<{ run_id: string }>(
          "select run_id from app.workflow_test_suite_cases where workspace_id=$1 and suite_id=$2 and status='running'",
          [input.workspaceId, input.suiteId],
        );
        const runId = active.rows[0]?.run_id;
        if (runId === undefined)
          await client.query(
            "update app.workflow_test_suites set status='canceled',completed_at=clock_timestamp() where workspace_id=$1 and id=$2",
            [input.workspaceId, input.suiteId],
          );
        else
          await cancelInTransaction(
            {
              db: drizzle(client, { schema: databaseSchema }),
              workspaceId: parseWorkspaceId(input.workspaceId),
            },
            { workspaceId: input.workspaceId, actorId: input.actorId, runId },
          );
      }),
  };
}

async function preparation(
  catalogs: AuthoringCatalogs,
  client: Parameters<typeof loadTestSnapshot>[0],
  input: SampleScope,
) {
  const snapshot = await loadTestSnapshot(client, input, catalogs);
  await lockInputCaseQuota(client, input.workspaceId);
  const transaction = {
    db: drizzle(client, { schema: databaseSchema }),
    workspaceId: parseWorkspaceId(input.workspaceId),
  };
  const variableSetRevision =
    await captureWorkspaceVariableRevision(transaction);
  const current = await readSuiteCurrent(client, input, variableSetRevision);
  return {
    snapshot,
    current,
    prepared: {
      ...current,
      effectfulSteps: snapshot.preparation.effectfulSteps,
    } satisfies WorkflowTestSuitePreparation,
  };
}
function prepareTestSuite(
  pool: Pool,
  catalogs: AuthoringCatalogs,
  input: Parameters<WorkflowTestSuiteStore['prepare']>[0],
): ReturnType<WorkflowTestSuiteStore['prepare']> {
  return withTestAuthority(
    pool,
    input,
    async (client) => (await preparation(catalogs, client, input)).prepared,
  );
}

function startTestSuite(
  pool: Pool,
  catalogs: AuthoringCatalogs,
  input: Parameters<WorkflowTestSuiteStore['start']>[0],
): ReturnType<WorkflowTestSuiteStore['start']> {
  return withTestAuthority(pool, input, async (client) => {
    const suiteId = generatePersistedId();
    const command = {
      workspaceId: input.workspaceId,
      operation: 'workflow.testsuite.start',
      scope: `${input.actorId}:${input.workflowId}`,
      idempotencyKey: input.idempotencyKey,
    };
    const replay = await claimCommand(client, {
      ...command,
      request: input.request,
      resourceId: suiteId,
    });
    if (replay !== null) return replay as { suiteId: string };
    const { snapshot, current } = await preparation(catalogs, client, input);
    if (current.cases.length === 0)
      throw new WorkflowTestError('cases_required');
    if (current.draftRevision !== input.request.expectedRevision)
      throw new WorkflowTestError('draft_changed');
    if (!sameTestSamples(current.samples, input.request.expectedSamples))
      throw new WorkflowTestError('samples_changed');
    const suiteChanged =
      current.variableSetRevision !==
        input.request.expectedVariableSetRevision ||
      current.signature !== input.request.signature ||
      canonicalJson(
        current.cases.map(({ id, revision }) => ({ id, revision })),
      ) !== canonicalJson(input.request.expectedCases);
    if (suiteChanged) throw new WorkflowTestError('cases_changed');
    if (
      canonicalJson([...input.request.expectedEffectfulSteps].sort()) !==
      canonicalJson(
        snapshot.preparation.effectfulSteps.map((step) => step.nodeId).sort(),
      )
    )
      throw new WorkflowTestError('effects_changed');
    if (
      snapshot.preparation.effectfulSteps.length > 0 &&
      !input.request.acknowledgeSideEffects
    )
      throw new WorkflowTestError('effects_acknowledgement_required');
    if (snapshot.usesConnections)
      await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
        actorId: input.actorId,
        roles: rolesForCapability('connection:use'),
      });
    await requireNoActiveSuite(client, input);
    await requireNoActiveTest(client, input);
    const cases = await client.query<{
      id: string;
      revision: number;
      name: string;
      input: string;
      expectations: string | null;
    }>(
      `select record.id,record.revision,record.name,payload.input,payload.expectations from app.workflow_input_cases record join app.workflow_input_case_payloads payload on payload.workspace_id=record.workspace_id and payload.case_id=record.id and payload.revision=record.revision where record.workspace_id=$1 and record.workflow_id=$2 and record.deleted_at is null order by record.created_at,record.id limit 50`,
      [input.workspaceId, input.workflowId],
    );
    if (cases.rowCount !== current.cases.length)
      throw new WorkflowTestError('cases_changed');
    for (const entry of cases.rows) {
      const expectations = (
        entry.expectations === null
          ? DEFAULT_TEST_EXPECTATIONS
          : JSON.parse(entry.expectations)
      ) as WorkflowTestExpectations;
      if (
        expectations.assertions.some(
          (assertion) =>
            assertion.source.kind === 'step' &&
            !Object.hasOwn(
              snapshot.compiled.dispositions,
              assertion.source.nodeId,
            ),
        )
      )
        throw new WorkflowTestError('case_invalid');
      await lockArtifactReferences(
        client,
        input.workspaceId,
        JSON.parse(entry.input) as unknown,
        input.actorId,
      );
    }
    await requireWorkflowCallTargets(client, input, snapshot.graph);
    await requireConnectionBindings(client, input, snapshot.graph);
    await lockArtifactReferences(
      client,
      input.workspaceId,
      snapshot.graph,
      input.actorId,
    );
    const snapshotId = generatePersistedId();
    await saveTestSnapshot(client, input, {
      id: snapshotId,
      snapshot,
      expiresAt: new Date(snapshot.now.getTime() + TEST_RUN_RETENTION_MILLIS),
    });
    const inserted = await client.query<SuiteRow>(
      `insert into app.workflow_test_suites(id,workspace_id,workflow_id,started_by,snapshot_id,signature,variable_set_revision,uses_connections,case_duration_ms,initial_checkpoint,created_at,deadline_at,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13) returning *`,
      [
        suiteId,
        input.workspaceId,
        input.workflowId,
        input.actorId,
        snapshotId,
        current.signature,
        current.variableSetRevision,
        snapshot.usesConnections,
        Math.min(300000, snapshot.graph.settings.maxRunDurationMs ?? 300000),
        JSON.stringify(snapshot.compiled.initialCheckpoint(snapshotId)),
        snapshot.now,
        new Date(snapshot.now.getTime() + 5 * 60 * 60 * 1000),
        new Date(snapshot.now.getTime() + TEST_RUN_RETENTION_MILLIS),
      ],
    );
    const suite = inserted.rows[0];
    if (suite === undefined) throw new Error('Suite admission is missing');
    const manifest = cases.rows.map((entry, ordinal) => ({
      ordinal,
      case_id: entry.id,
      case_revision: entry.revision,
      name: entry.name,
      input: entry.input,
      expectations:
        entry.expectations ?? canonicalJson(DEFAULT_TEST_EXPECTATIONS),
    }));
    await client.query(
      `insert into app.workflow_test_suite_cases(workspace_id,suite_id,ordinal,case_id,case_revision,name,input,expectations)
    select $1,$2,entry.ordinal,entry.case_id,entry.case_revision,entry.name,entry.input,entry.expectations from jsonb_to_recordset($3::jsonb) entry(ordinal integer,case_id uuid,case_revision integer,name text,input text,expectations text)`,
      [input.workspaceId, suiteId, JSON.stringify(manifest)],
    );
    const first = await client.query<SuiteCaseRow>(
      'select * from app.workflow_test_suite_cases where workspace_id=$1 and suite_id=$2 and ordinal=0',
      [input.workspaceId, suiteId],
    );
    const entry = first.rows[0];
    if (entry === undefined) throw new Error('Suite has no first case');
    await admitSuiteCase(client, suite, entry, snapshot.now);
    const result = { suiteId };
    await completeCommand(client, command, result);
    return result;
  });
}
