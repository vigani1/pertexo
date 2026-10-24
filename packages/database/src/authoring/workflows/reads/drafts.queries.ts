import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import {
  workflowDrafts,
  workflowVersions,
  workflows,
} from '../../../schema/authoring/workflows.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { dataTableReferenceIssues } from '../../../data-tables/columns/references.queries.js';

import {
  projectDraft,
  draftProjection,
} from '../representation/records.queries.js';

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
      const [row] = await drizzle(client)
        .select(draftProjection)
        .from(workflowDrafts)
        .where(
          and(
            eq(workflowDrafts.workspaceId, workspaceId),
            eq(workflowDrafts.workflowId, uuidSchema.parse(workflowId)),
          ),
        )
        .catch(rethrowQueryFailure);
      if (row === undefined) return null;
      const draft = projectDraft(row, variant.definitionCatalog);
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
          and(
            eq(workflows.workspaceId, workspaceId),
            eq(workflows.id, workflowId),
          ),
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
    const [row] = await drizzle(client)
      .select(draftProjection)
      .from(workflowDrafts)
      .where(
        and(
          eq(workflowDrafts.workspaceId, workspaceId),
          eq(workflowDrafts.workflowId, uuidSchema.parse(workflowId)),
        ),
      )
      .catch(rethrowQueryFailure);
    return row === undefined ? null : projectDraft(row, definitionCatalog);
  });
}
