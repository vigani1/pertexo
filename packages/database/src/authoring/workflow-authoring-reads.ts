import type { PoolClient } from 'pg';
import { z } from 'zod';

import { WorkflowNotFoundError } from './workflow-authoring-errors.js';
import {
  mapDraft,
  mapVersion,
  mapWorkflow,
  workflowVersionRowSelection,
} from './workflow-authoring-rows.js';
import type {
  ListWorkflowsInput,
  ListWorkflowVersionsInput,
  WorkflowAuthoringDatabase,
  WorkflowDraftRecord,
  WorkflowPage,
  WorkflowVersionPage,
  WorkflowVersionRecord,
} from './workflow-authoring.js';
import type { WorkflowDefinitionCatalogV1 } from '@pertexo/workflow-model/graph';

type ReadStore = Pick<
  WorkflowAuthoringDatabase,
  'getDraft' | 'getVersion' | 'listVersions' | 'listWorkflows'
>;

export type WorkflowAuthoringReadContext = Readonly<{
  requireReader(
    client: PoolClient,
    workspaceId: string,
    actorId: string,
  ): Promise<void>;
  selectDefinitionCatalog(
    client: Pick<PoolClient, 'query'>,
  ): Promise<WorkflowDefinitionCatalogV1>;
  transact<T>(
    workspaceId: string,
    actorId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T>;
}>;

const uuidSchema = z.uuid();

export function createWorkflowAuthoringReadStore(
  context: WorkflowAuthoringReadContext,
): ReadStore {
  return Object.freeze({
    listWorkflows: (input: ListWorkflowsInput): Promise<WorkflowPage> =>
      context.transact(input.workspaceId, input.actorId, async (client) => {
        await context.requireReader(client, input.workspaceId, input.actorId);
        const limit = z
          .number()
          .int()
          .positive()
          .max(100)
          .parse(input.limit ?? 50);
        const afterCreatedAt = input.after?.createdAt ?? null;
        if (
          afterCreatedAt !== null &&
          (!(afterCreatedAt instanceof Date) ||
            !Number.isFinite(afterCreatedAt.getTime()))
        )
          throw new Error('Invalid workflow list cursor time');
        const afterId =
          input.after === undefined ? null : uuidSchema.parse(input.after.id);
        const result = await client.query<Record<string, unknown>>(
          `select * from app.workflows where workspace_id = $1
             and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::uuid))
           order by created_at, id limit $4`,
          [input.workspaceId, afterCreatedAt, afterId, limit + 1],
        );
        const hasMore = result.rows.length > limit;
        const items = Object.freeze(
          result.rows.slice(0, limit).map((row) => mapWorkflow(row)),
        );
        const last = items.at(-1);
        return Object.freeze({
          items,
          ...(hasMore && last !== undefined
            ? {
                nextCursor: Object.freeze({
                  createdAt: last.createdAt,
                  id: last.id,
                }),
              }
            : {}),
        });
      }),
    getDraft: (
      workspaceId: string,
      workflowId: string,
      actorId: string,
    ): Promise<WorkflowDraftRecord | null> =>
      context.transact(workspaceId, actorId, async (client) => {
        await context.requireReader(client, workspaceId, actorId);
        const definitionCatalog = await context.selectDefinitionCatalog(client);
        const result = await client.query<Record<string, unknown>>(
          'select * from app.workflow_drafts where workspace_id = $1 and workflow_id = $2',
          [workspaceId, uuidSchema.parse(workflowId)],
        );
        return result.rows[0] === undefined
          ? null
          : mapDraft(result.rows[0], definitionCatalog);
      }),
    getVersion: (
      workspaceId: string,
      workflowId: string,
      versionId: string,
      actorId: string,
    ): Promise<WorkflowVersionRecord | null> =>
      context.transact(workspaceId, actorId, async (client) => {
        await context.requireReader(client, workspaceId, actorId);
        const result = await client.query<Record<string, unknown>>(
          `select ${workflowVersionRowSelection} from app.workflow_versions
           where workspace_id = $1 and workflow_id = $2 and id = $3`,
          [
            workspaceId,
            uuidSchema.parse(workflowId),
            uuidSchema.parse(versionId),
          ],
        );
        return result.rows[0] === undefined ? null : mapVersion(result.rows[0]);
      }),
    listVersions: (
      input: ListWorkflowVersionsInput,
    ): Promise<WorkflowVersionPage> =>
      context.transact(input.workspaceId, input.actorId, async (client) => {
        await context.requireReader(client, input.workspaceId, input.actorId);
        const workflowId = uuidSchema.parse(input.workflowId);
        const visible = await client.query(
          'select 1 from app.workflows where workspace_id = $1 and id = $2',
          [input.workspaceId, workflowId],
        );
        if (visible.rowCount !== 1)
          throw new WorkflowNotFoundError('Workflow is not visible');
        const limit = z
          .number()
          .int()
          .positive()
          .max(100)
          .parse(input.limit ?? 50);
        const beforeVersionNumber =
          input.beforeVersionNumber === undefined
            ? null
            : z.number().int().positive().parse(input.beforeVersionNumber);
        const result = await client.query<Record<string, unknown>>(
          `select ${workflowVersionRowSelection} from app.workflow_versions
           where workspace_id = $1 and workflow_id = $2
             and ($3::integer is null or version_number < $3)
           order by version_number desc limit $4`,
          [input.workspaceId, workflowId, beforeVersionNumber, limit + 1],
        );
        const hasMore = result.rows.length > limit;
        const items = Object.freeze(
          result.rows.slice(0, limit).map((row) => mapVersion(row)),
        );
        const last = items.at(-1);
        return Object.freeze({
          items,
          ...(hasMore && last !== undefined
            ? {
                nextCursor: Object.freeze({
                  beforeVersionNumber: last.versionNumber,
                }),
              }
            : {}),
        });
      }),
  });
}
