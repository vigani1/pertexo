import { dataTableReferenceIssues } from '../../../data-tables/columns/references.queries.js';

import { mapDraft } from '../representation/records.queries.js';

import {
  sameWorkflowNotes,
  parseWorkflowGraphDraft,
} from '@pertexo/workflow-model';
import { admitWorkflowAuthoring } from '../admission.queries.js';

import { parseWorkflowGraphForPublish } from '@pertexo/workflow-model/server';
import type { ReadStore, WorkflowAuthoringReadContext } from './contract.js';
import { uuidSchema, canReadWorkflow } from './authority.js';

export function validateAuthoringDraft(
  context: WorkflowAuthoringReadContext,
  workspaceId: Parameters<ReadStore['validateDraft']>[0],
  {
    workflowId,
    actorId,
    options = {},
  }: Readonly<{
    workflowId: Parameters<ReadStore['validateDraft']>[1];
    actorId: Parameters<ReadStore['validateDraft']>[2];
    options?: Parameters<ReadStore['validateDraft']>[3] | undefined;
  }>,
): ReturnType<ReadStore['validateDraft']> {
  return context.transact(
    workspaceId,
    actorId,
    async (client) => {
      if (
        !(await canReadWorkflow(context, client, {
          workspaceId,
          actorId,
          workflowId,
        }))
      )
        return null;
      const variant = context.catalogs;
      const result = await client.query<Record<string, unknown>>(
        'select * from app.workflow_drafts where workspace_id = $1 and workflow_id = $2',
        [workspaceId, uuidSchema.parse(workflowId)],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const draft = mapDraft(row, variant.definitionCatalog);
      let validation = await admitWorkflowAuthoring(
        client,
        variant.validateAuthoringGraph,
        parseWorkflowGraphDraft(draft.graphJson),
        options.signal === undefined ? {} : { signal: options.signal },
      );
      if (validation.ok) {
        const issues = await dataTableReferenceIssues(
          client,
          workspaceId,
          draft.graphJson,
        );
        if (issues.length > 0)
          validation = { ...validation, ok: false, issues };
      }
      const publication = await client.query<{
        versionId: string;
        versionNumber: number;
        checksum: string;
        graphJson: unknown;
      }>(
        `select version.id as "versionId", version.version_number as "versionNumber", version.checksum, version.graph_json as "graphJson"
             from app.workflows workflow join app.workflow_versions version
               on version.workspace_id = workflow.workspace_id and version.workflow_id = workflow.id
                 and version.id = workflow.published_version_id
             where workflow.workspace_id = $1 and workflow.id = $2`,
        [workspaceId, workflowId],
      );
      const live = publication.rows[0];
      const currentPublication =
        live === undefined
          ? null
          : Object.freeze({
              versionId: live.versionId,
              versionNumber: live.versionNumber,
              matchesDraft:
                validation.ok &&
                draft.compatibility.compatible &&
                variant.executableCompiler(
                  parseWorkflowGraphForPublish(
                    draft.graphJson,
                    variant.definitionCatalog,
                  ),
                ).checksum === live.checksum &&
                sameWorkflowNotes(
                  draft.graphJson,
                  parseWorkflowGraphDraft(live.graphJson),
                ),
            });
      return Object.freeze({ draft, validation, currentPublication });
    },
    options.signal,
  );
}

export function readAuthoringDraft(
  context: WorkflowAuthoringReadContext,
  workspaceId: Parameters<ReadStore['getDraft']>[0],
  workflowId: Parameters<ReadStore['getDraft']>[1],
  actorId: Parameters<ReadStore['getDraft']>[2],
): ReturnType<ReadStore['getDraft']> {
  return context.transact(workspaceId, actorId, async (client) => {
    if (
      !(await canReadWorkflow(context, client, {
        workspaceId,
        actorId,
        workflowId,
      }))
    )
      return null;
    const { definitionCatalog } = context.catalogs;
    const result = await client.query<Record<string, unknown>>(
      'select * from app.workflow_drafts where workspace_id = $1 and workflow_id = $2',
      [workspaceId, uuidSchema.parse(workflowId)],
    );
    return result.rows[0] === undefined
      ? null
      : mapDraft(result.rows[0], definitionCatalog);
  });
}
