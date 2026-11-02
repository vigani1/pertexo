import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { dataTableReferenceIssues } from '../../../data-tables/columns/references.queries.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowDrafts,
  workflowVersions,
  workflows,
} from '@pertexo/database/schema';

import {
  draftProjection,
  projectDraft,
} from '../representation/records.queries.js';

import {
  parseWorkflowGraphDraft,
  sameWorkflowNotes,
} from '@pertexo/workflow-model';
import { stepSettingsIssues } from '../../publication/step-settings.js';
import { admitWorkflowAuthoring } from '../admission.queries.js';

import {
  parseWorkflowGraphForPublish,
  type WorkflowDefinitionCatalog,
} from '@pertexo/workflow-model/server';
import type { PoolClient } from 'pg';
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import type { FolderScope } from '../../../shared/contract.js';
import { workflowAccessible } from '../../../tenant-access/resources/workflows.queries.js';
import type { WorkflowRef } from '../access.js';
import type { AuthoringCatalogs } from '../catalogs.js';

type ValidationCatalogs = Pick<
  AuthoringCatalogs,
  | 'definitionCatalog'
  | 'validateAuthoringGraph'
  | 'executableCompiler'
  | 'portableCatalog'
>;

export async function validateDraft(
  client: PoolClient,
  scope: FolderScope,
  {
    signal,
    ...workflow
  }: WorkflowRef & Readonly<{ signal?: AbortSignal | undefined }>,
  catalogs: ValidationCatalogs,
) {
  const { workspaceId, workflowId } = workflow;
  if (!(await workflowAccessible(client, scope, workflow))) return null;
  const [row] = await drizzle(client)
    .select(draftProjection)
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, workspaceId),
        eq(workflowDrafts.workflowId, workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined) return null;
  const draft = projectDraft(row, catalogs.definitionCatalog);
  let validation = await admitWorkflowAuthoring(
    client,
    catalogs.validateAuthoringGraph,
    parseWorkflowGraphDraft(draft.graphJson),
    signal === undefined ? {} : { signal },
  );
  if (validation.ok) {
    const issues = [
      ...stepSettingsIssues(draft.graphJson, catalogs.portableCatalog),
      ...(await dataTableReferenceIssues(client, workspaceId, draft.graphJson)),
    ];
    if (issues.length > 0) validation = { ...validation, ok: false, issues };
  }
  const [live] = await drizzle(client)
    .select({
      versionId: workflowVersions.id,
      versionNumber: workflowVersions.versionNumber,
      checksum: workflowVersions.checksum,
      graphJson: workflowVersions.graphJson,
    })
    .from(workflows)
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.workspaceId, workflows.workspaceId),
        eq(workflowVersions.workflowId, workflows.id),
        eq(workflowVersions.id, workflows.publishedVersionId),
      ),
    )
    .where(
      and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)),
    )
    .catch(rethrowQueryFailure);
  const currentPublication =
    live === undefined
      ? null
      : Object.freeze({
          versionId: live.versionId,
          versionNumber: live.versionNumber,
          matchesDraft:
            validation.ok &&
            draft.compatibility.compatible &&
            compilesToChecksum(catalogs, draft.graphJson, live.checksum) &&
            sameWorkflowNotes(
              draft.graphJson,
              parseWorkflowGraphDraft(live.graphJson),
            ),
        });
  return Object.freeze({ draft, validation, currentPublication });
}

/**
 * The draft's schemas accept setups the compiler refuses. Publishing reports
 * those; here it only means the draft can't be what is published.
 */
function compilesToChecksum(
  { executableCompiler, definitionCatalog }: ValidationCatalogs,
  graphJson: unknown,
  checksum: string,
): boolean {
  try {
    return (
      executableCompiler(
        parseWorkflowGraphForPublish(graphJson, definitionCatalog),
      ).checksum === checksum
    );
  } catch (error) {
    if (
      error instanceof WorkflowEngineError &&
      error.code === 'executable_invalid'
    )
      return false;
    throw error;
  }
}

export async function readDraft(
  client: PoolClient,
  scope: FolderScope,
  workflow: WorkflowRef,
  definitionCatalog: WorkflowDefinitionCatalog,
) {
  if (!(await workflowAccessible(client, scope, workflow))) return null;
  const [row] = await drizzle(client)
    .select(draftProjection)
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, workflow.workspaceId),
        eq(workflowDrafts.workflowId, workflow.workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row === undefined ? null : projectDraft(row, definitionCatalog);
}
