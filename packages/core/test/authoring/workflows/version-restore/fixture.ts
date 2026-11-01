import { expect } from 'vitest';
import {
  actorId,
  apiPool,
  authoring,
  currentRepresentationTag,
  emptyGraph,
  finishTransactionClient,
  queryAsOwner,
  randomUUID,
  saveCurrentDraft,
  testDefinitionCatalog,
  workspaceId,
} from '../../../support/workflow-authoring.js';

type RestoreFixture = Readonly<{
  workflowId: string;
  firstVersionId: string;
  secondVersionId: string;
  currentGraph: ReturnType<typeof graphWithDuration>;
}>;

export function graphWithDuration(duration: number) {
  return { ...emptyGraph, settings: { maxRunDurationMs: duration } };
}

export const blockedDefinitionCatalog = Object.freeze({
  definitions: Object.freeze([
    Object.freeze({ key: 'test.blocked', version: 1 }),
  ]),
});

export const currentDefinitionCatalog = Object.freeze({
  ...testDefinitionCatalog,
});

export async function createRestoreFixture(
  name: string,
  database = authoring,
): Promise<RestoreFixture> {
  const created = await database.createWorkflow({
    actorId,
    emptyGraph,
    idempotencyKey: `restore-create-${name}`,
    name: `Restore ${name}`,
    workspaceId,
  });
  const first = await database.publishWorkflow({
    actorId,
    representationTag: await currentRepresentationTag(database, workspaceId, {
      scopedWorkflowId: created.workflowId,
      scopedActorId: actorId,
    }),
    idempotencyKey: `restore-publish-first-${name}`,
    requestHash: '1'.repeat(64),
    workflowId: created.workflowId,
    workspaceId,
  });
  const firstGraph = graphWithDuration(1_000);
  await saveCurrentDraft(database, {
    actorId,
    expectedRevision: 1,
    graphJson: firstGraph,
    workflowId: created.workflowId,
    workspaceId,
  });
  const second = await database.publishWorkflow({
    actorId,
    representationTag: await currentRepresentationTag(database, workspaceId, {
      scopedWorkflowId: created.workflowId,
      scopedActorId: actorId,
    }),
    idempotencyKey: `restore-publish-second-${name}`,
    requestHash: '2'.repeat(64),
    workflowId: created.workflowId,
    workspaceId,
  });
  const currentGraph = graphWithDuration(2_000);
  await saveCurrentDraft(database, {
    actorId,
    expectedRevision: 2,
    graphJson: currentGraph,
    workflowId: created.workflowId,
    workspaceId,
  });
  return Object.freeze({
    workflowId: created.workflowId,
    firstVersionId: first.version.id,
    secondVersionId: second.version.id,
    currentGraph,
  });
}

export async function restoreInput(
  fixture: RestoreFixture,
  database = authoring,
  representationTag?: string,
) {
  return {
    actorId,
    representationTag:
      representationTag ??
      (await currentRepresentationTag(database, workspaceId, {
        scopedWorkflowId: fixture.workflowId,
        scopedActorId: actorId,
      })),
    versionId: fixture.firstVersionId,
    workflowId: fixture.workflowId,
    workspaceId,
  } as const;
}

export async function restoreFacts(scopedWorkflowId: string) {
  const rows = await queryAsOwner<{
    draft_graph: unknown;
    draft_revision: number;
    first_version_graph: unknown;
    first_version_checksum: string | null;
    pointer: string | null;
    versions: number;
    outbox: number;
    publication_audits: number;
    restore_audits: number;
  }>(
    `select draft.revision as draft_revision,
            draft.graph_json as draft_graph,
            (select version.graph_json from app.workflow_versions version
              where version.workflow_id=$1 order by version.version_number limit 1)
              as first_version_graph,
            (select version.checksum from app.workflow_versions version
              where version.workflow_id=$1 order by version.version_number limit 1)
              as first_version_checksum,
            workflow.published_version_id::text as pointer,
            (select count(*)::int from app.workflow_versions version
              where version.workflow_id=$1) as versions,
            (select count(*)::int from app.outbox_events event
              where event.aggregate_id=$1) as outbox,
            (select count(*)::int from app.audit_events event
              where event.target_id=$1 and event.action='workflow.published')
              as publication_audits,
            (select count(*)::int from app.audit_events event
              where event.target_id=$1 and event.action='workflow.version_restored')
              as restore_audits
       from app.workflow_drafts draft
       join app.workflows workflow
         on workflow.workspace_id=draft.workspace_id
        and workflow.id=draft.workflow_id
      where draft.workflow_id=$1`,
    [scopedWorkflowId],
    workspaceId,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('Expected restore facts');
  return row;
}

export async function insertSucceededRun(
  scopedWorkflowId: string,
  versionId: string,
): Promise<string> {
  const runId = randomUUID();
  const client = await apiPool.connect();
  let transactionOpen = false;
  let primaryError: unknown;
  try {
    await client.query('begin');
    transactionOpen = true;
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    await client.query(
      `insert into app.workflow_runs
         (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
          execution_entitlement_version)
       values($1,$2,$3,$4,'manual','succeeded',1)`,
      [runId, workspaceId, scopedWorkflowId, versionId],
    );
    await client.query('commit');
    transactionOpen = false;
  } catch (error: unknown) {
    primaryError = error;
  }
  await finishTransactionClient(client, {
    label: 'Succeeded-run fixture insert',
    primaryError,
    transactionOpen,
  });
  return runId;
}

export async function persistedRun(runId: string): Promise<string> {
  const client = await apiPool.connect();
  let transactionOpen = false;
  let primaryError: unknown;
  let value: string | undefined;
  try {
    await client.query('begin');
    transactionOpen = true;
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await client.query<{ value: string }>(
      'select row_to_json(run)::text value from app.workflow_runs run where id=$1',
      [runId],
    );
    await client.query('commit');
    transactionOpen = false;
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Expected nonempty retained run');
    value = row.value;
  } catch (error: unknown) {
    primaryError = error;
  }
  await finishTransactionClient(client, {
    label: 'Persisted-run fixture query',
    primaryError,
    transactionOpen,
  });
  if (value === undefined) throw new Error('Persisted run is missing');
  return value;
}
