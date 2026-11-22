import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
} from '@pertexo/policy';
import type { Pool } from 'pg';
import {
  withWorkspaceAccess,
  type WorkspaceActor,
} from '../../../shared/access/workspace-access.js';
import {
  isAvailableAssistantConnection,
  readAssistantSelection,
  updateAssistantSelection,
  type AssistantSelection,
} from './assistant-settings.repository.js';

type ModelIdentity = Readonly<{ providerKey: string; authType: string }>;

export type AssistantSettingsStore = ReturnType<
  typeof createAssistantSettingsStore
>;

export function createAssistantSettingsStore(pool: Pool) {
  return Object.freeze({
    read: (actor: WorkspaceActor) =>
      withWorkspaceAccess(
        pool,
        actor,
        {
          mode: 'read',
          capability: 'workspace:read',
          statuses: BROWSABLE_WORKSPACE_STATUSES,
        },
        (client) => readAssistantSelection(client, actor.workspaceId),
      ),
    update: (
      actor: WorkspaceActor,
      selection: AssistantSelection | null,
      identity: ModelIdentity,
    ) =>
      withWorkspaceAccess(
        pool,
        actor,
        {
          mode: 'exclusive',
          capability: 'connection:manage',
          statuses: ACTIVE_WORKSPACE_STATUSES,
        },
        async (client, role) => {
          if (
            selection !== null &&
            !(await isAvailableAssistantConnection(client, actor, role, {
              ...identity,
              connectionId: selection.connectionId,
            }))
          )
            return { kind: 'connection_unavailable' as const };
          await updateAssistantSelection(client, actor.workspaceId, selection);
          return { kind: 'saved' as const, selection };
        },
      ),
  });
}
