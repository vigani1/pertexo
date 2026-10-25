import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '../../../../platform/query-errors.js';
import {
  workflowOrganizationState,
  workflowTagAssignments,
  workflowTags,
} from '../../../../schema/authoring/organization.js';
import { workflows } from '../../../../schema/authoring/workflows.js';

import {
  runOrganizationCommand,
  type OrganizationScope,
} from '../../commands.repository.js';
import { WorkflowTagConflictError } from '../../errors.js';

import { TAG_DELETE_WORKFLOW_LIMIT, TAG_LIMIT } from '../../limits.js';
import type { createOrganizationSession } from '../../session.js';
import type { WorkflowTagDatabase } from '../contract.js';
import { assignment, deleteResult, replaceResult } from '../input.js';
import {
  readTag,
  requireFreeKey,
  requireRevision,
  tagProjection,
} from '../state.queries.js';
import { ADMINISTRATORS, assignmentCommand, tagCommand } from './receipts.js';

/** Detaches a tag from at most 50 workflows, advancing each one's revision. */
async function deleteTag(
  client: PoolClient,
  scope: OrganizationScope,
  tagId: string,
): Promise<number> {
  const db = drizzle(client);
  const assigned = await db
    .select({ workflowId: workflowTagAssignments.workflowId })
    .from(workflowTagAssignments)
    .where(
      and(
        eq(workflowTagAssignments.workspaceId, scope.workspaceId),
        eq(workflowTagAssignments.tagId, tagId),
      ),
    )
    .orderBy(asc(workflowTagAssignments.workflowId))
    .limit(TAG_DELETE_WORKFLOW_LIMIT + 1)
    .catch(rethrowQueryFailure);
  if (assigned.length > TAG_DELETE_WORKFLOW_LIMIT)
    throw new WorkflowTagConflictError('delete_overflow');
  const workflowIds = assigned.map((row) => row.workflowId);
  await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, scope.workspaceId),
        inArray(workflows.id, workflowIds),
      ),
    )
    .orderBy(asc(workflows.id))
    .for('update')
    .catch(rethrowQueryFailure);
  if (workflowIds.length > 0)
    await db
      .insert(workflowOrganizationState)
      .values(
        workflowIds.map((workflowId) => ({
          workspaceId: scope.workspaceId,
          workflowId,
          revision: 2,
        })),
      )
      .onConflictDoUpdate({
        target: [
          workflowOrganizationState.workspaceId,
          workflowOrganizationState.workflowId,
        ],
        set: { revision: sql`${workflowOrganizationState.revision}+1` },
      })
      .catch(rethrowQueryFailure);
  await db
    .delete(workflowTagAssignments)
    .where(
      and(
        eq(workflowTagAssignments.workspaceId, scope.workspaceId),
        eq(workflowTagAssignments.tagId, tagId),
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .delete(workflowTags)
    .where(
      and(
        eq(workflowTags.workspaceId, scope.workspaceId),
        eq(workflowTags.id, tagId),
      ),
    )
    .catch(rethrowQueryFailure);
  return workflowIds.length;
}

export async function createTag(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowTagDatabase['createTag']>[0],
): ReturnType<WorkflowTagDatabase['createTag']> {
  const request = { key: input.key };
  return tagCommand(session, input, {
    operation: 'tag.create',
    target: null,
    request,
    apply: async (client, workspaceId) => {
      await requireFreeKey(client, workspaceId, request.key, null);
      const db = drizzle(client);
      const [count] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(workflowTags)
        .where(eq(workflowTags.workspaceId, workspaceId))
        .catch(rethrowQueryFailure);
      if ((count?.count ?? 0) >= TAG_LIMIT)
        throw new WorkflowTagConflictError('limit');
      const [row] = await db
        .insert(workflowTags)
        .values({ workspaceId, id: sql`uuidv7()`, key: request.key })
        .returning(tagProjection)
        .catch(rethrowQueryFailure);
      if (row === undefined) throw new Error('Tag was not created');
      return row;
    },
  });
}

export async function renameTag(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowTagDatabase['renameTag']>[0],
): ReturnType<WorkflowTagDatabase['renameTag']> {
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
      const [renamed] = await drizzle(client)
        .update(workflowTags)
        .set({ key: request.key, revision: sql`${workflowTags.revision}+1` })
        .where(
          and(
            eq(workflowTags.workspaceId, workspaceId),
            eq(workflowTags.id, tagId),
          ),
        )
        .returning(tagProjection)
        .catch(rethrowQueryFailure);
      return renamed ?? current;
    },
  });
}

export async function deleteTagCommand(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowTagDatabase['deleteTag']>[0],
): ReturnType<WorkflowTagDatabase['deleteTag']> {
  const tagId = input.tagId;
  const request = {
    expectedTagRevision: input.expectedTagRevision,
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
    change: { kind: 'replace_tags', tagIds: input.tagIds },
    schema: replaceResult,
  });
}

export async function detachTag(
  session: ReturnType<typeof createOrganizationSession>,
  input: Parameters<WorkflowTagDatabase['detachTag']>[0],
): ReturnType<WorkflowTagDatabase['detachTag']> {
  return assignmentCommand(session, input, {
    operation: 'tag.detach',
    change: { kind: 'detach_tag', tagId: input.tagId },
    schema: assignment,
  });
}
