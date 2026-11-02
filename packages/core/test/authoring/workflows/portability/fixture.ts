import {
  parseWorkflowGraphDraft,
  projectWorkflowPortableManifest,
  type WorkflowPortabilityCatalog,
} from '@pertexo/workflow-model';
import { workflowDefinitionCatalogFingerprint } from '@pertexo/workflow-model/server';
import { verifyCuratedTemplateManifest } from '@pertexo/templates';

import type { ImportWorkflowInput } from '../../../../src/authoring/workflows/contract.js';

import type { WorkflowAuthoringStoreOptions } from '../../../../src/authoring/workflows/types.js';
import {
  actorId,
  workspaceId,
  apiUrl,
  createWorkflowAuthoringStore,
  parseDatabaseConfig,
  emptyGraph,
  randomUUID,
  queryAsOwner,
} from '../../../support/workflow-authoring.js';

export const catalog = {
  definitions: [{ key: 'test.placeholder', version: 1 }],
};

export const portableCatalog: WorkflowPortabilityCatalog = {
  definitions: [
    {
      key: 'test.placeholder',
      version: 1,
      configVersion: 1,
      slots: [],
      validateConfig: () => true,
    },
  ],
};

const options: Partial<WorkflowAuthoringStoreOptions> = {
  definitionCatalog: catalog,
  portableCatalog,
};

const databases: ReturnType<typeof createWorkflowAuthoringStore>[] = [];

export function database(
  extra: Partial<WorkflowAuthoringStoreOptions> = {},
  url = apiUrl,
) {
  const result = createWorkflowAuthoringStore(
    parseDatabaseConfig({ connectionString: url, max: 4 }),
    { ...options, ...extra },
  );
  databases.push(result);
  return result;
}

export function command(
  extra: Partial<ImportWorkflowInput> = {},
): ImportWorkflowInput {
  const { templateOrigin, templateIssues: _issues, ...rest } = extra;
  const input = {
    workspaceId,
    actorId,
    name: 'Portable independent workflow',
    manifest: projectWorkflowPortableManifest(
      parseWorkflowGraphDraft(emptyGraph),
      portableCatalog,
    ),
    bindings: [],
    expectedCompatibilityFingerprint:
      workflowDefinitionCatalogFingerprint(catalog),
    idempotencyKey: randomUUID(),
    ...rest,
  };
  if (templateOrigin === undefined) return input;
  const verified = verifyCuratedTemplateManifest(
    input.manifest,
    templateOrigin,
  );
  return {
    ...input,
    templateOrigin,
    templateIssues: verified.ok ? [] : verified.issues,
  };
}

export async function facts() {
  return queryAsOwner(
    `select (select count(*)::int from app.workflows where workspace_id=$1) workflows,
    (select count(*)::int from app.workflow_drafts where workspace_id=$1) drafts,
    (select count(*)::int from app.idempotency_records where workspace_id=$1 and operation='workflow.import') receipts,
    (select count(*)::int from app.audit_events where workspace_id=$1 and action='workflow.imported') audits`,
    [workspaceId],
    workspaceId,
  );
}

export async function firstFacts() {
  const row = (await facts())[0];
  if (row === undefined) throw new Error('Expected import fact counts');
  return row;
}

export function importReceipts(receipt: readonly [string, string]) {
  return queryAsOwner(
    "select resource_id from app.idempotency_records where workspace_id=$1 and operation='workflow.import' and resource_id=$2",
    [...receipt],
    workspaceId,
  );
}

export function inputForPreview(input: ImportWorkflowInput) {
  return {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    manifest: input.manifest,
    bindings: input.bindings,
  };
}

export async function afterEachFixture1() {
  await Promise.all(databases.splice(0).map((db) => db.close()));
}
