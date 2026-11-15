import { WORKFLOW_ORGANIZATION_LIMITS } from '@pertexo/workflow-model';

import type { PoolClient } from 'pg';

import { runOrganizationCommand } from '../../run-command.js';

import type {
  OrganizationScope,
  createOrganizationSession,
} from '../../session.js';

import { WorkflowTagConflictError } from '../../workflow-organization.errors.js';

import type {
  CreateTagInput,
  DeleteTagInput,
  DetachTagInput,
  RenameTagInput,
  ReplaceTagsInput,
  WorkflowTagAssignmentResult,
  WorkflowTagCommandResult,
  WorkflowTagDeleteResult,
  WorkflowTagReplaceResult,
} from '../workflow-tag.types.js';

import {
  assignment,
  deleteResult,
  replaceResult,
} from '../tag-receipts.schemas.js';

import { readTag, requireFreeKey, requireRevision } from '../tag-state.js';

import { assignmentCommand, tagCommand } from './receipts.js';

import {
  countTags,
  detachTagFromWorkflows,
  insertTag,
  readTagAssignments,
  renameTagRow,
} from './mutations.repository.js';

/** Detaches a tag from at most 50 workflows, advancing each one's revision. */
async function deleteTag(
  client: PoolClient,
  scope: OrganizationScope,
  tagId: string,
): Promise<number> {
  const assigned = await readTagAssignments(client, scope.workspaceId, tagId);
  if (assigned.length > WORKFLOW_ORGANIZATION_LIMITS.cleanupItems)
    throw new WorkflowTagConflictError('delete_overflow');
  const workflowIds = assigned.map((row) => row.workflowId);
  await detachTagFromWorkflows(client, scope.workspaceId, tagId, workflowIds);
  return workflowIds.length;
}

export async function createTag(
  session: ReturnType<typeof createOrganizationSession>,
  input: CreateTagInput,
): Promise<WorkflowTagCommandResult> {
  const request = { key: input.key };
  return tagCommand(session, input, {
    operation: 'tag.create',
    target: null,
    request,
    apply: async (client, workspaceId) => {
      await requireFreeKey(client, workspaceId, request.key, null);
      const tags = await countTags(client, workspaceId);
      if (tags >= WORKFLOW_ORGANIZATION_LIMITS.tagsPerWorkspace)
        throw new WorkflowTagConflictError('limit');
      const row = await insertTag(client, workspaceId, request.key);
      return row;
    },
  });
}

export async function renameTag(
  session: ReturnType<typeof createOrganizationSession>,
  input: RenameTagInput,
): Promise<WorkflowTagCommandResult> {
  const tagId = input.tagId;
  const request = {
    key: input.key,
    expectedTagRevision: input.expectedTagRevision,
  };
  return tagCommand(session, input, {
    operation: 'tag.rename',
    target: tagId,
    request,
    apply: async (client, workspaceId) => {
      const current = await readTag(client, workspaceId, tagId);
      requireRevision(current, request.expectedTagRevision);
      await requireFreeKey(client, workspaceId, request.key, tagId);
      const renamed = await renameTagRow(
        client,
        workspaceId,
        tagId,
        request.key,
      );
      return renamed ?? current;
    },
  });
}

export async function deleteTagCommand(
  session: ReturnType<typeof createOrganizationSession>,
  input: DeleteTagInput,
): Promise<WorkflowTagDeleteResult> {
  const tagId = input.tagId;
  const request = {
    expectedTagRevision: input.expectedTagRevision,
  };
  return session.command(input, 'governance:manage', async (client, scope) => {
    const { result, replayed } = await runOrganizationCommand(client, scope, {
      receipt: deleteResult,
      operation: 'tag.delete',
      target: tagId,
      idempotencyKey: input.idempotencyKey,
      request,
      apply: async () => {
        const current = await readTag(client, scope.workspaceId, tagId);
        requireRevision(current, request.expectedTagRevision);
        const detachedWorkflowCount = await deleteTag(client, scope, tagId);
        return {
          result: { tagId, deleted: true as const, detachedWorkflowCount },
          audit: {
            action: 'workflow.tag.delete',
            targetId: tagId,
            metadata: { detachedWorkflowCount },
          },
        };
      },
    });
    return Object.freeze({ ...result, replayed });
  });
}

export async function replaceWorkflowTags(
  session: ReturnType<typeof createOrganizationSession>,
  input: ReplaceTagsInput,
): Promise<WorkflowTagReplaceResult> {
  return assignmentCommand(session, input, {
    operation: 'tags.replace',
    change: { kind: 'replace_tags', tagIds: input.tagIds },
    schema: replaceResult,
  });
}

export async function detachTag(
  session: ReturnType<typeof createOrganizationSession>,
  input: DetachTagInput,
): Promise<WorkflowTagAssignmentResult> {
  return assignmentCommand(session, input, {
    operation: 'tag.detach',
    change: { kind: 'detach_tag', tagId: input.tagId },
    schema: assignment,
  });
}
