import {
  ADMINISTRATIVE_ROLES,
  WORKFLOW_EDITOR_ROLES,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import type { z } from 'zod';

import { runOrganizationCommand } from '../../commands.repository.js';

import {
  checkOrganizationReplay,
  organizeWorkflow,
  type OrganizationChange,
} from '../../placement.repository.js';
import type { createOrganizationSession } from '../../session.js';
import {
  type Command,
  type AssignmentCommand,
  type WorkflowTagCommandResult,
  uuid,
  revision,
  tagResult,
} from '../contract.js';
import { type TagRow, tagRecord } from '../state.queries.js';

export const ADMINISTRATORS = ADMINISTRATIVE_ROLES;

const EDITORS = WORKFLOW_EDITOR_ROLES;

export function tagCommand(
  session: ReturnType<typeof createOrganizationSession>,
  input: Command,
  {
    operation,
    target,
    request,
    apply,
  }: Readonly<{
    operation: string;
    target: string | null;
    request: unknown;
    apply: (client: PoolClient, workspaceId: string) => Promise<TagRow>;
  }>,
): Promise<WorkflowTagCommandResult> {
  return session.transact(input, async (client, scope) => {
    const { result, replayed } = await runOrganizationCommand(client, scope, {
      operation,
      target,
      idempotencyKey: input.idempotencyKey,
      request,
      roles: ADMINISTRATORS,
      apply: async () => {
        const row = await apply(client, scope.workspaceId);
        return {
          result: { tag: tagRecord(row) },
          audit: {
            action: `workflow.${operation}`,
            targetId: row.id,
            metadata: { revision: Number(row.revision) },
          },
        };
      },
    });
    return Object.freeze({ ...tagResult.parse(result), replayed });
  });
}

/** Replacing tags or detaching one from a workflow. */
export function assignmentCommand<T extends object>(
  session: ReturnType<typeof createOrganizationSession>,
  input: AssignmentCommand,
  {
    operation,
    change,
    schema,
  }: Readonly<{
    operation: 'tags.replace' | 'tag.detach';
    change: Exclude<OrganizationChange, Readonly<{ kind: 'move' }>>;
    schema: z.ZodType<T>;
  }>,
): Promise<T & Readonly<{ replayed: boolean }>> {
  const workflowId = uuid.parse(input.workflowId);
  const expectedOrganizationRevision = revision.parse(
    input.expectedOrganizationRevision,
  );
  const request =
    change.kind === 'replace_tags'
      ? { tagIds: change.tagIds, expectedOrganizationRevision }
      : { tagId: change.tagId, expectedOrganizationRevision };
  return session.transact(input, async (client, scope) => {
    const { result, replayed } = await runOrganizationCommand(client, scope, {
      operation,
      target: workflowId,
      idempotencyKey: input.idempotencyKey,
      request,
      roles: operation === 'tags.replace' ? EDITORS : ADMINISTRATORS,
      replay: () =>
        checkOrganizationReplay(client, scope, {
          workflowId,
          kind: change.kind,
        }),
      apply: async () => {
        const organizationRevision = await organizeWorkflow(client, scope, {
          workflowId,
          change,
          expectedOrganizationRevision,
        });
        return {
          result: {
            workflowId,
            organizationRevision,
            ...(change.kind === 'replace_tags'
              ? { tagIds: change.tagIds }
              : {}),
          },
          audit: {
            action: `workflow.${operation}`,
            targetId: workflowId,
            metadata: { organizationRevision },
          },
        };
      },
    });
    return Object.freeze({ ...schema.parse(result), replayed });
  });
}
