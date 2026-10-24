import type { WorkflowPromotionHistory } from '@pertexo/contracts';
import { sql } from 'drizzle-orm';
import { readFolderScope } from '../../tenant-access/resources/facts.queries.js';
import {
  bindResourcePredicate,
  workflowScopeSql,
} from '../../tenant-access/resources/scope.queries.js';

import { requirePromotionAuthority } from './authority.queries.js';
import type { PromotionContext, WorkflowPromotionStore } from './contract.js';

export function promotionReads(
  context: PromotionContext,
): Pick<WorkflowPromotionStore, 'candidates' | 'history'> {
  return {
    candidates: (input) =>
      context.transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requirePromotionAuthority(client, input);
          const resources = await readFolderScope(client, input);
          if (input.workflowId !== undefined) {
            const parameters: unknown[] = [
              input.workspaceId,
              input.workflowId,
              input.beforeVersionNumber ?? null,
              input.limit + 1,
            ];
            const visible = bindResourcePredicate(
              workflowScopeSql(resources, sql`workflow.id`),
              parameters,
            );
            const result = await client.query<{
              workflow_id: string;
              name: string;
              id: string;
              version_number: number;
            }>(
              `select version.workflow_id,workflow.name,version.id,version.version_number from app.workflow_versions version join app.workflows workflow on workflow.workspace_id=version.workspace_id and workflow.id=version.workflow_id where version.workspace_id=$1 and version.workflow_id=$2 and ${visible} and workflow.lifecycle_status='active' and ($3::integer is null or version.version_number<$3) order by version.version_number desc limit $4`,
              parameters,
            );
            const rows = result.rows.slice(0, input.limit);
            return {
              items: rows.map((row) => ({
                workflowId: row.workflow_id,
                name: row.name,
                versionId: row.id,
                versionNumber: row.version_number,
              })),
              nextCursor: null,
              nextVersionNumber:
                result.rows.length > input.limit
                  ? (rows.at(-1)?.version_number ?? null)
                  : null,
            };
          }

          const parameters: unknown[] = [
            input.workspaceId,
            input.after ?? null,
            input.search ?? null,
            input.limit + 1,
          ];
          const visible = bindResourcePredicate(
            workflowScopeSql(resources, sql`workflow.id`),
            parameters,
          );
          const result = await client.query<{
            id: string;
            name: string;
            version_id: string;
            version_number: number;
          }>(
            `select workflow.id,workflow.name,version.id version_id,version.version_number from app.workflows workflow
         join app.workflow_versions version on version.workspace_id=workflow.workspace_id and version.workflow_id=workflow.id and version.id=workflow.published_version_id
         where workflow.workspace_id=$1 and ${visible} and workflow.lifecycle_status='active' and ($2::uuid is null or workflow.id>$2) and ($3::text is null or position(lower($3) in lower(workflow.name))>0)
         order by workflow.id limit $4`,
            parameters,
          );
          const page = result.rows.slice(0, input.limit);
          return {
            nextVersionNumber: null,
            items: page.map((row) => ({
              workflowId: row.id,
              name: row.name,
              versionId: row.version_id,
              versionNumber: row.version_number,
            })),
            nextCursor:
              result.rows.length > input.limit
                ? (page.at(-1)?.id ?? null)
                : null,
          };
        },
        input.signal,
      ),
    history: (input) =>
      context.transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requirePromotionAuthority(client, input);
          const resources = await readFolderScope(client, input);
          const parameters: unknown[] = [
            input.workspaceId,
            input.after ?? null,
            input.limit + 1,
          ];
          const visible = bindResourcePredicate(
            workflowScopeSql(resources, sql`event.target_id`),
            parameters,
          );
          const result = await client.query<{
            id: string;
            actor_user_id: string | null;
            actor_name: string;
            occurred_at: Date;
            target_id: string;
            metadata: Omit<
              WorkflowPromotionHistory['items'][number],
              'id' | 'occurredAt' | 'actorId' | 'actorName' | 'workflowId'
            >;
          }>(
            `select event.id,event.actor_user_id,coalesce(actor.display_name,'Former member') actor_name,event.occurred_at,event.target_id,event.metadata from app.audit_events event left join app.users actor on actor.id=event.actor_user_id
         where event.workspace_id=$1 and ${visible} and event.action in ('workflow.promoted','workflow.promotion_sent') and ($2::uuid is null or event.id<$2)
         order by event.id desc limit $3`,
            parameters,
          );
          const items = result.rows.slice(0, input.limit).map((row) => ({
            id: row.id,
            promotionId: row.metadata.promotionId,
            occurredAt: row.occurred_at.toISOString(),
            actorId: row.actor_user_id,
            actorName: row.actor_name,
            workflowId: row.target_id,
            workflowName: row.metadata.workflowName,
            sourceWorkspaceId: row.metadata.sourceWorkspaceId,
            sourceWorkflowId: row.metadata.sourceWorkflowId,
            sourceVersionId: row.metadata.sourceVersionId,
            targetWorkspaceId: row.metadata.targetWorkspaceId,
            targetWorkflowId: row.metadata.targetWorkflowId,
            targetVersionId: row.metadata.targetVersionId,
            publicationRequestId: row.metadata.publicationRequestId,
            mode: row.metadata.mode,
          }));
          return {
            items,
            nextCursor:
              result.rows.length > input.limit
                ? (items.at(-1)?.id ?? null)
                : null,
          };
        },
        input.signal,
      ),
  };
}
