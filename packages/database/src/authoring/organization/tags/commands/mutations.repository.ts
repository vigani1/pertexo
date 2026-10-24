import type { PoolClient } from 'pg';

import {
  runOrganizationCommand,
  type OrganizationScope,
} from '../../commands.repository.js';
import { WorkflowTagConflictError } from '../../errors.js';

import type { createOrganizationSession } from '../../session.js';
import {
  type WorkflowTagDatabase,
  TAG_LIMIT,
  TAG_DELETE_WORKFLOW_LIMIT,
  uuid,
  revision,
  key,
  assignment,
  deleteResult,
  tagIds,
  replaceResult,
} from '../contract.js';
import {
  type TagRow,
  readTag,
  requireFreeKey,
  requireRevision,
} from '../state.queries.js';
import { ADMINISTRATORS, tagCommand, assignmentCommand } from './receipts.js';

/** Detaches a tag from at most 50 workflows, advancing each one's revision. */
async function deleteTag(
  client: PoolClient,
  scope: OrganizationScope,
  tagId: string,
): Promise<number> {
  const assigned = await client.query<{ workflow_id: string }>(
    `select workflow_id from app.workflow_tag_assignments
     where workspace_id = $1 and tag_id = $2 order by workflow_id limit $3`,
    [scope.workspaceId, tagId, TAG_DELETE_WORKFLOW_LIMIT + 1],
  );
  if (assigned.rows.length > TAG_DELETE_WORKFLOW_LIMIT)
    throw new WorkflowTagConflictError('delete_overflow');
  const workflowIds = assigned.rows.map((row) => row.workflow_id);
  await client.query(
    `select 1 from app.workflows
     where workspace_id = $1 and id = any($2::uuid[]) order by id for update`,
    [scope.workspaceId, workflowIds],
  );
  await client.query(
    `insert into app.workflow_organization_state (workspace_id, workflow_id, revision)
     select $1, workflow_id, 2 from unnest($2::uuid[]) workflow_id
     on conflict (workspace_id, workflow_id) do update
     set revision = app.workflow_organization_state.revision + 1`,
    [scope.workspaceId, workflowIds],
  );
  await client.query(
    'delete from app.workflow_tag_assignments where workspace_id = $1 and tag_id = $2',
    [scope.workspaceId, tagId],
  );
  await client.query(
    'delete from app.workflow_tags where workspace_id = $1 and id = $2',
    [scope.workspaceId, tagId],
  );
  return workflowIds.length;
}

export async function createTag(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowTagDatabase['createTag']>[0],
): ReturnType<WorkflowTagDatabase['createTag']> {
  const request = { key: key.parse(input.key) };
  return tagCommand(session, input, {
    operation: 'tag.create',
    target: null,
    request,
    apply: async (client, workspaceId) => {
      await requireFreeKey(client, workspaceId, request.key, null);
      const count = await client.query<{ count: number }>(
        'select count(*)::int count from app.workflow_tags where workspace_id = $1',
        [workspaceId],
      );
      if ((count.rows[0]?.count ?? 0) >= TAG_LIMIT)
        throw new WorkflowTagConflictError('limit');
      const created = await client.query<TagRow>(
        `insert into app.workflow_tags (workspace_id, id, key)
             values ($1, uuidv7(), $2) returning id, key, revision`,
        [workspaceId, request.key],
      );
      const row = created.rows[0];
      if (row === undefined) throw new Error('Tag was not created');
      return row;
    },
  });
}

export async function renameTag(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowTagDatabase['renameTag']>[0],
): ReturnType<WorkflowTagDatabase['renameTag']> {
  const tagId = uuid.parse(input.tagId);
  const request = {
    key: key.parse(input.key),
    expectedTagRevision: revision.parse(input.expectedTagRevision),
  };
  return tagCommand(session, input, {
    operation: 'tag.rename',
    target: tagId,
    request,
    apply: async (client, workspaceId) => {
      const current = await readTag(client, workspaceId, tagId);
      requireRevision(current, request.expectedTagRevision);
      await requireFreeKey(client, workspaceId, request.key, tagId);
      const renamed = await client.query<TagRow>(
        `update app.workflow_tags set key = $3, revision = revision + 1
             where workspace_id = $1 and id = $2 returning id, key, revision`,
        [workspaceId, tagId, request.key],
      );
      return renamed.rows[0] ?? current;
    },
  });
}

export async function deleteTagCommand(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowTagDatabase['deleteTag']>[0],
): ReturnType<WorkflowTagDatabase['deleteTag']> {
  const tagId = uuid.parse(input.tagId);
  const request = {
    expectedTagRevision: revision.parse(input.expectedTagRevision),
  };
  return session.transact(input, async (client, scope) => {
    const { result, replayed } = await runOrganizationCommand(client, scope, {
      operation: 'tag.delete',
      target: tagId,
      idempotencyKey: input.idempotencyKey,
      request,
      roles: ADMINISTRATORS,
      apply: async () => {
        const current = await readTag(client, scope.workspaceId, tagId);
        requireRevision(current, request.expectedTagRevision);
        const detachedWorkflowCount = await deleteTag(client, scope, tagId);
        return {
          result: { tagId, deleted: true, detachedWorkflowCount },
          audit: {
            action: 'workflow.tag.delete',
            targetId: tagId,
            metadata: { detachedWorkflowCount },
          },
        };
      },
    });
    return Object.freeze({ ...deleteResult.parse(result), replayed });
  });
}

export async function replaceWorkflowTags(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowTagDatabase['replaceTags']>[0],
): ReturnType<WorkflowTagDatabase['replaceTags']> {
  return assignmentCommand(session, input, {
    operation: 'tags.replace',
    change: { kind: 'replace_tags', tagIds: tagIds.parse(input.tagIds) },
    schema: replaceResult,
  });
}

export async function detachTag(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowTagDatabase['detachTag']>[0],
): ReturnType<WorkflowTagDatabase['detachTag']> {
  return assignmentCommand(session, input, {
    operation: 'tag.detach',
    change: { kind: 'detach_tag', tagId: uuid.parse(input.tagId) },
    schema: assignment,
  });
}
