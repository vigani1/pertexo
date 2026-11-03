import { requireWorkflowInScope } from '../../workflows/access.js';
import { readFolderScope } from '../../../shared/facts.repository.js';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workflowFavorites, workflows } from '@pertexo/database/schema';

import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { WorkflowNotFoundError } from '../../workflows/workflow-authoring.errors.js';
import {
  createOrganizationSession,
  type OrganizationRequestScope,
} from '../session.js';

export type WorkflowFavoriteCommand = OrganizationRequestScope &
  Readonly<{ workflowId: string; favorite: boolean }>;
export type WorkflowFavoriteState = Readonly<{ isFavorite: boolean }>;

export type WorkflowFavoriteStore = ReturnType<
  typeof createWorkflowFavoriteStore
>;

/** Favorites are private to each member and go when the member leaves. */
export function createWorkflowFavoriteStore(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
) {
  const session = createOrganizationSession(config, options.runtime);
  return Object.freeze({
    /** Asking for the state it already has changes nothing, so retries are safe. */
    setFavorite: async (
      input: WorkflowFavoriteCommand,
    ): Promise<WorkflowFavoriteState> => {
      const workflowId = input.workflowId;
      return session.read(
        input,
        'workflow:read',
        ACTIVE_WORKSPACE_STATUSES,
        async (client, scope) => {
          await requireWorkflowInScope(
            client,
            await readFolderScope(client, scope, scope.role),
            { workspaceId: scope.workspaceId, workflowId },
            'workflow:read',
          );
          const db = drizzle(client);
          const workflow = await db
            .select({ id: workflows.id })
            .from(workflows)
            .where(
              and(
                eq(workflows.workspaceId, scope.workspaceId),
                eq(workflows.id, workflowId),
              ),
            )
            .for('share')
            .catch(rethrowQueryFailure);
          if (workflow.length !== 1)
            throw new WorkflowNotFoundError('Workflow is not visible');
          if (input.favorite)
            await db
              .insert(workflowFavorites)
              .values({
                workspaceId: scope.workspaceId,
                actorId: scope.actorId,
                workflowId,
              })
              .onConflictDoNothing()
              .catch(rethrowQueryFailure);
          else
            await db
              .delete(workflowFavorites)
              .where(
                and(
                  eq(workflowFavorites.workspaceId, scope.workspaceId),
                  eq(workflowFavorites.actorId, scope.actorId),
                  eq(workflowFavorites.workflowId, workflowId),
                ),
              )
              .catch(rethrowQueryFailure);
          return Object.freeze({ isFavorite: input.favorite });
        },
      );
    },
    close: session.close,
  });
}
