import type { PoolClient } from 'pg';
import { z } from 'zod';

import { WorkflowNotFoundError } from './errors.js';
import { createWorkflowTemplateOriginReader } from '../portability/template-origin.js';
import {
  mapDraft,
  mapVersion,
  mapWorkflow,
  workflowVersionRowSelection,
} from './representation/rows.js';
import type {
  ListWorkflowsInput,
  ListWorkflowVersionsInput,
  WorkflowAuthoringDatabase,
  WorkflowPage,
  WorkflowVersionPage,
} from './contracts.js';
import type {
  WorkflowDraftRecord,
  WorkflowVersionRecord,
} from './representation/records.js';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { admitWorkflowAuthoring } from './admission.js';
import type { AuthoringCatalogs } from './catalogs.js';
import { parseWorkflowGraphForPublish } from '@pertexo/workflow-model/server';

type ReadStore = Pick<
  WorkflowAuthoringDatabase,
  | 'getDraft'
  | 'validateDraft'
  | 'getVersion'
  | 'getWorkflow'
  | 'getWorkflowWithTemplateOrigin'
  | 'listVersions'
  | 'listWorkflows'
>;

export type WorkflowAuthoringReadContext = Readonly<{
  requireReader(
    client: PoolClient,
    workspaceId: string,
    actorId: string,
  ): Promise<void>;
  catalogs: Pick<
    AuthoringCatalogs,
    'definitionCatalog' | 'validateAuthoringGraph' | 'executableCompiler'
  >;
  transact<T>(
    workspaceId: string,
    actorId: string,
    operation: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}>;

const uuidSchema = z.uuid();

export function createWorkflowAuthoringReadStore(
  context: WorkflowAuthoringReadContext,
): ReadStore {
  return Object.freeze({
    getWorkflowWithTemplateOrigin: createWorkflowTemplateOriginReader(context),
    validateDraft: (
      workspaceId: string,
      workflowId: string,
      actorId: string,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ) =>
      context.transact(
        workspaceId,
        actorId,
        async (client) => {
          await context.requireReader(client, workspaceId, actorId);
          const variant = context.catalogs;
          const result = await client.query<Record<string, unknown>>(
            'select * from app.workflow_drafts where workspace_id = $1 and workflow_id = $2',
            [workspaceId, uuidSchema.parse(workflowId)],
          );
          const row = result.rows[0];
          if (row === undefined) return null;
          const draft = mapDraft(row, variant.definitionCatalog);
          const validation = await admitWorkflowAuthoring(
            client,
            variant.validateAuthoringGraph,
            parseWorkflowGraphDraft(draft.graphJson),
            options.signal === undefined ? {} : { signal: options.signal },
          );
          const publication = await client.query<{
            versionId: string;
            versionNumber: number;
            checksum: string;
          }>(
            `select version.id as "versionId", version.version_number as "versionNumber", version.checksum
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
                    ).checksum === live.checksum,
                });
          return Object.freeze({ draft, validation, currentPublication });
        },
        options.signal,
      ),
    getWorkflow: (workspaceId: string, workflowId: string, actorId: string) =>
      context.transact(workspaceId, actorId, async (client) => {
        await context.requireReader(client, workspaceId, actorId);
        const result = await client.query<Record<string, unknown>>(
          'select * from app.workflows where workspace_id = $1 and id = $2',
          [workspaceId, uuidSchema.parse(workflowId)],
        );
        return result.rows[0] === undefined
          ? null
          : mapWorkflow(result.rows[0]);
      }),
    listWorkflows: (input: ListWorkflowsInput): Promise<WorkflowPage> =>
      context.transact(input.workspaceId, input.actorId, async (client) => {
        await context.requireReader(client, input.workspaceId, input.actorId);
        const limit = z
          .number()
          .int()
          .positive()
          .max(100)
          .parse(input.limit ?? 50);
        const order = input.order ?? 'created_asc';
        const afterPositionAt =
          input.after === undefined
            ? null
            : z.iso.datetime({ offset: true }).parse(input.after.positionAt);
        const afterId =
          input.after === undefined ? null : uuidSchema.parse(input.after.id);
        const result = await client.query<Record<string, unknown>>(
          order === 'updated_desc'
            ? `select *, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_position_at
               from app.workflows where workspace_id = $1
                 and ($5::uuid is null or exists(select 1 from app.workflow_version_dependencies dependency
                   where dependency.workspace_id=$1 and dependency.parent_version_id=app.workflows.published_version_id
                     and dependency.target_workflow_id=$5))
                 and ($2::timestamptz is null or (updated_at, id) < ($2::timestamptz, $3::uuid))
               order by updated_at desc, id desc limit $4`
            : `select *, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_position_at
               from app.workflows where workspace_id = $1
                 and ($5::uuid is null or exists(select 1 from app.workflow_version_dependencies dependency
                   where dependency.workspace_id=$1 and dependency.parent_version_id=app.workflows.published_version_id
                     and dependency.target_workflow_id=$5))
                 and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::uuid))
               order by created_at, id limit $4`,
          [
            input.workspaceId,
            afterPositionAt,
            afterId,
            limit + 1,
            input.pinsWorkflowId === undefined
              ? null
              : uuidSchema.parse(input.pinsWorkflowId),
          ],
        );
        const hasMore = result.rows.length > limit;
        const pageRows = result.rows.slice(0, limit);
        const items = Object.freeze(
          pageRows.map((row) => {
            const workflowRow = { ...row };
            delete workflowRow.cursor_position_at;
            return mapWorkflow(workflowRow);
          }),
        );
        const last = items.at(-1);
        return Object.freeze({
          items,
          ...(hasMore && last !== undefined
            ? {
                nextCursor: Object.freeze({
                  positionAt: z
                    .string()
                    .parse(pageRows.at(-1)?.cursor_position_at),
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
        const { definitionCatalog } = context.catalogs;
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
             and ($5::uuid is null or id = $5)
           order by version_number desc limit $4`,
          [
            input.workspaceId,
            workflowId,
            beforeVersionNumber,
            limit + 1,
            input.versionId ?? null,
          ],
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
