import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '../../schema/authoring/workflows.js';
import { workflowFavorites } from '../../schema/authoring/organization.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { ROLES } from '@pertexo/workflow-model';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { WorkflowNotFoundError } from '../workflows/errors.js';
import {
  createOrganizationSession,
  type OrganizationRequestScope,
} from './session.js';

export type WorkflowFavoriteCommand = OrganizationRequestScope &
  Readonly<{ workflowId: string; favorite: boolean }>;
export type WorkflowFavoriteState = Readonly<{ isFavorite: boolean }>;

export interface WorkflowFavoriteDatabase {
  /** Marks or unmarks a workflow as one of the actor's favorites. Asking for
   * the state it already has changes nothing, so retries are safe. */
  setFavorite(input: WorkflowFavoriteCommand): Promise<WorkflowFavoriteState>;
  close(): Promise<void>;
}

const uuid = z.uuid().overwrite((value) => value.toLowerCase());

/** Favorites are private to each member and go when the member leaves. */
export function createWorkflowFavoriteDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowFavoriteDatabase {
  const session = createOrganizationSession(config, options.runtime);
  return Object.freeze({
    setFavorite: async (input: WorkflowFavoriteCommand) => {
      const workflowId = uuid.parse(input.workflowId);
      return session.transact(input, async (client, scope) => {
        await lockWorkflowAuthoringAuthority(client, scope.workspaceId, {
          actorId: scope.actorId,
          roles: ROLES,
          resource: { workflowId, capability: 'workflow:read' },
        });
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
      });
    },
    close: session.close,
  });
}
