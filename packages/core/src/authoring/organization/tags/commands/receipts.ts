import type { PoolClient } from 'pg';
import type { z } from 'zod';

import { runOrganizationCommand } from '../../run-command.js';

import {
  checkOrganizationReplay,
  organizeWorkflow,
  type OrganizationChange,
} from '../../placement.repository.js';
import type { createOrganizationSession } from '../../session.js';
import type {
  AssignmentCommand,
  Command,
  WorkflowTagCommandResult,
} from '../workflow-tag.types.js';
import { tagResult } from '../input.js';
import type { TagRow } from '../state.repository.js';

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
  return session.command(input, 'governance:manage', async (client, scope) => {
    const { result, replayed } = await runOrganizationCommand(client, scope, {
      receipt: tagResult,
      operation,
      target,
      idempotencyKey: input.idempotencyKey,
      request,
      apply: async () => {
        const row = await apply(client, scope.workspaceId);
        return {
          result: { tag: row },
          audit: {
            action: `workflow.${operation}`,
            targetId: row.id,
            metadata: { revision: row.revision },
          },
        };
      },
    });
    return Object.freeze({ ...result, replayed });
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
  const workflowId = input.workflowId;
  const expectedOrganizationRevision = input.expectedOrganizationRevision;
  const request =
    change.kind === 'replace_tags'
      ? { tagIds: change.tagIds, expectedOrganizationRevision }
      : { tagId: change.tagId, expectedOrganizationRevision };
  return session.command(
    input,
    operation === 'tags.replace' ? 'workflow:update' : 'governance:manage',
    async (client, scope) => {
      const { result, replayed } = await runOrganizationCommand(client, scope, {
        receipt: schema,
        operation,
        target: workflowId,
        idempotencyKey: input.idempotencyKey,
        request,
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
            result: schema.parse({
              workflowId,
              organizationRevision,
              ...(change.kind === 'replace_tags'
                ? { tagIds: change.tagIds }
                : {}),
            }),
            audit: {
              action: `workflow.${operation}`,
              targetId: workflowId,
              metadata: { organizationRevision },
            },
          };
        },
      });
      return Object.freeze({ ...result, replayed });
    },
  );
}
