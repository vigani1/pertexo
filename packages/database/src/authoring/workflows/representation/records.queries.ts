import { and, eq, exists, isNull, ne, or, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import {
  workflows,
  workflowDrafts,
  workflowVersions,
  workflowTriggers,
} from '../../../schema/authoring/workflows.js';
import { webhookTriggerEndpoints } from '../../../schema/triggers/endpoints.js';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import {
  workflowCompatibilityReport,
  type WorkflowDefinitionCatalog,
} from '@pertexo/workflow-model/server';

import type { WorkflowDraftRecord, WorkflowVersionRecord } from './contract.js';

const missingEndpoint = new QueryBuilder()
  .select({ id: workflowTriggers.id })
  .from(workflowTriggers)
  .leftJoin(
    webhookTriggerEndpoints,
    and(
      eq(webhookTriggerEndpoints.workspaceId, workflowTriggers.workspaceId),
      eq(webhookTriggerEndpoints.triggerId, workflowTriggers.id),
    ),
  )
  .where(
    and(
      eq(workflowTriggers.workspaceId, workflows.workspaceId),
      eq(workflowTriggers.workflowId, workflows.id),
      eq(workflowTriggers.workflowVersionId, workflows.publishedVersionId),
      eq(workflowTriggers.kind, 'webhook'),
      or(
        isNull(webhookTriggerEndpoints.id),
        ne(webhookTriggerEndpoints.status, 'active'),
      ),
    ),
  );
export const workflowProjection = {
  id: workflows.id,
  workspaceId: workflows.workspaceId,
  name: workflows.name,
  nameRevision: workflows.nameRevision,
  lifecycleStatus: workflows.lifecycleStatus,
  lifecycleRevision: workflows.lifecycleRevision,
  activationStatus: workflows.activationStatus,
  webhookSetupRequired: sql<boolean>`${exists(missingEndpoint)}`,
  publishedVersionId: workflows.publishedVersionId,
  createdBy: workflows.createdBy,
  createdAt: workflows.createdAt,
  updatedAt: workflows.updatedAt,
};
export const draftProjection = {
  workflowId: workflowDrafts.workflowId,
  workspaceId: workflowDrafts.workspaceId,
  revision: workflowDrafts.revision,
  graphJson: workflowDrafts.graphJson,
  updatedBy: workflowDrafts.updatedBy,
  updatedAt: workflowDrafts.updatedAt,
};
export const versionProjection = {
  id: workflowVersions.id,
  workspaceId: workflowVersions.workspaceId,
  workflowId: workflowVersions.workflowId,
  versionNumber: workflowVersions.versionNumber,
  graphJson: workflowVersions.graphJson,
  checksum: workflowVersions.checksum,
  publishedBy: workflowVersions.publishedBy,
  publishedAt: workflowVersions.publishedAt,
};
export function projectDraft(
  row: Pick<typeof workflowDrafts.$inferSelect, keyof typeof draftProjection>,
  catalog: WorkflowDefinitionCatalog,
): WorkflowDraftRecord {
  const graph = parseWorkflowGraphDraft(row.graphJson);
  return Object.freeze({
    ...row,
    graphJson: graph,
    compatibility: workflowCompatibilityReport(graph, catalog),
  });
}
export function projectVersion(
  row: Pick<
    typeof workflowVersions.$inferSelect,
    keyof typeof versionProjection
  >,
): WorkflowVersionRecord {
  return Object.freeze({
    ...row,
    graphJson: parseWorkflowGraphDraft(row.graphJson),
  });
}
