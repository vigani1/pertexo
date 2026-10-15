import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import { ROLES } from '../../tenant-access/policy.js';
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
        await lockWorkflowAuthoringAuthority(
          client,
          scope.workspaceId,
          scope.actorId,
          ROLES,
        );
        const workflow = await client.query(
          'select 1 from app.workflows where workspace_id = $1 and id = $2 for share',
          [scope.workspaceId, workflowId],
        );
        if (workflow.rowCount !== 1)
          throw new WorkflowNotFoundError('Workflow is not visible');
        await client.query(
          input.favorite
            ? `insert into app.workflow_favorites (workspace_id, actor_id, workflow_id)
               values ($1, $2, $3) on conflict do nothing`
            : `delete from app.workflow_favorites
               where workspace_id = $1 and actor_id = $2 and workflow_id = $3`,
          [scope.workspaceId, scope.actorId, workflowId],
        );
        return Object.freeze({ isFavorite: input.favorite });
      });
    },
    close: session.close,
  });
}
