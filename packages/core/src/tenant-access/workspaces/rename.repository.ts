import {
  appendAuditFact,
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { users, workspaces } from '@pertexo/database/schema';

import type { CommandIdentity } from '@pertexo/database/primitives';
import type {
  RenameWorkspaceInput,
  WorkspaceRenameResult,
} from '../contract.js';
import { WorkspaceRenameCommandConflictError } from '../errors.js';
import { readLockedMembers } from '../members/commands.repository.js';
import { isActiveMemberManager } from '../members/manager.js';
import { workspaceRecord, workspaceSelection } from './projection.js';

function durableResult(result: WorkspaceRenameResult) {
  return {
    workspace: {
      ...result.workspace,
      createdAt: result.workspace.createdAt.toISOString(),
      updatedAt: result.workspace.updatedAt.toISOString(),
    },
    changed: result.changed,
  };
}

function replayedResult({
  workspace,
  changed,
}: ReturnType<typeof durableResult>): WorkspaceRenameResult {
  return Object.freeze({
    workspace: Object.freeze({
      ...workspace,
      createdAt: new Date(workspace.createdAt),
      updatedAt: new Date(workspace.updatedAt),
    }),
    changed,
    replayed: true,
  });
}

export function createIdentityWorkspaceRenameStore(pool: Pool) {
  return Object.freeze({
    renameWorkspace: async (raw: RenameWorkspaceInput) => {
      const workspaceId = raw.workspaceId;
      const actorUserId = raw.actorUserId;
      const name = raw.name;
      const expectedRevision = raw.expectedRevision;
      const key: CommandIdentity = {
        workspaceId,
        operation: 'workspace.rename',
        scope: actorUserId,
        idempotencyKey: raw.idempotencyKey,
      };
      // Off withWorkspaceAccess: it locks the actor's user for update. The helper's
      // share lock on that user would come first, and two commands by one person
      // in two workspaces would each hold it and wait for the other's update, dying
      // with 40P01. 'exclusive' only runs one at a time per workspace. It also
      // answers with its own reasons, not a denial.
      return withTenantScopedClient(
        pool,
        { workspaceId, actorId: actorUserId },
        async (client): Promise<WorkspaceRenameResult> => {
          const db = drizzle(client);
          const workspace = await db
            .select(workspaceSelection)
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .for('update')
            .catch(rethrowQueryFailure);
          const current = workspace[0];
          if (current?.status !== 'active')
            throw new WorkspaceRenameCommandConflictError(
              'workspace_inactive',
              'Only active workspaces can be renamed',
            );
          await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, actorUserId))
            .for('update')
            .catch(rethrowQueryFailure);
          const [actor] = await readLockedMembers(client, workspaceId, [
            actorUserId,
          ]);
          if (!isActiveMemberManager(actor))
            throw new WorkspaceRenameCommandConflictError(
              'actor_inactive',
              'The actor cannot manage this workspace',
            );
          const stored = await claimCommand<ReturnType<typeof durableResult>>(
            client,
            {
              ...key,
              request: { name, expectedRevision },
              resourceId: workspaceId,
            },
          );
          if (stored !== null) return replayedResult(stored);
          const currentWorkspace = workspaceRecord(current);
          if (currentWorkspace.revision !== expectedRevision)
            throw new WorkspaceRenameCommandConflictError(
              'revision_conflict',
              'The workspace changed since it was loaded',
            );
          const changed = currentWorkspace.name !== name;
          let renamed = currentWorkspace;
          if (changed) {
            const updated = await db
              .update(workspaces)
              .set({
                name,
                revision: sql`${workspaces.revision}+1`,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(workspaces.id, workspaceId))
              .returning(workspaceSelection)
              .catch(rethrowQueryFailure);
            const changedWorkspace = updated[0];
            if (changedWorkspace === undefined)
              throw new Error('Workspace rename returned no record');
            renamed = workspaceRecord(changedWorkspace);
            await appendAuditFact(client, {
              workspaceId,
              actorId: actorUserId,
              action: 'workspace.renamed',
              targetType: 'workspace',
              targetId: workspaceId,
              requestId: raw.requestId ?? null,
              traceId: raw.traceId ?? null,
              metadata: {
                fromName: currentWorkspace.name,
                toName: renamed.name,
                fromRevision: currentWorkspace.revision,
                toRevision: renamed.revision,
              },
            });
          }
          const result = Object.freeze({
            workspace: renamed,
            changed,
            replayed: false,
          });
          await completeCommand(client, key, durableResult(result));
          return result;
        },
      );
    },
  });
}
