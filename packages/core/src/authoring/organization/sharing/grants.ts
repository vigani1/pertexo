import {
  sharingReceipt,
  readFolderAccess,
  readFolderGrantRows,
  countActiveMembers,
  readLinkedGroups,
  replaceFolderGrants,
} from './grants.repository.js';

import { folderGrantDigest } from './audience-digests.js';

import type { PoolClient } from 'pg';

import { FOLDER_GRANT_LIMIT } from '@pertexo/workflow-model';

import type { FolderSharing, FolderSharingRequest } from '@pertexo/contracts';

import { WorkflowNotFoundError } from '../../workflows/workflow-authoring.errors.js';

import {
  FolderSharingCorruptError,
  WorkflowFolderConflictError,
} from '../workflow-organization.errors.js';

import type { OrganizationActor } from '../session.js';

import { runOrganizationCommand } from '../run-command.js';

export async function readFolderSharing(
  client: PoolClient,
  scope: OrganizationActor,
  folderId: string,
): Promise<FolderSharing> {
  const folder = await readFolderAccess(client, scope.workspaceId, folderId);
  if (folder === undefined)
    throw new WorkflowNotFoundError('Folder is not visible');
  const rows = await readFolderGrantRows(client, scope.workspaceId, folderId);
  const grants = rows.map(({ principal }) => principal);
  if (grants.length > FOLDER_GRANT_LIMIT) throw new FolderSharingCorruptError();
  return {
    folderId,
    revision: folder.revision,
    mode: folder.mode,
    grants,
    labels: Object.fromEntries(
      rows.map(({ principal, label }) => [
        principal.kind === 'member' ? principal.userId : principal.groupId,
        label,
      ]),
    ),
  };
}

export async function replaceFolderSharing(
  client: PoolClient,
  scope: OrganizationActor,
  input: {
    folderId: string;
    request: FolderSharingRequest;
    idempotencyKey: string;
  },
): Promise<FolderSharing & { replayed: boolean }> {
  const request = input.request;
  const outcome = await runOrganizationCommand(client, scope, {
    receipt: sharingReceipt,
    operation: 'folder.sharing',
    target: input.folderId,
    idempotencyKey: input.idempotencyKey,
    request,
    replay: async () => {
      await readFolderSharing(client, scope, input.folderId);
    },
    apply: async () => {
      const current = await readFolderSharing(client, scope, input.folderId);
      if (current.revision !== request.expectedFolderRevision)
        throw new WorkflowFolderConflictError('revision');
      const users = request.grants.flatMap((grant) =>
        grant.kind === 'member' ? [grant.userId] : [],
      );
      const groups = request.grants.filter((grant) => grant.kind === 'group');
      const members = await countActiveMembers(
        client,
        scope.workspaceId,
        users,
      );
      const linked = await readLinkedGroups(client, scope.workspaceId, groups);
      if (
        members !== users.length ||
        groups.some(
          (grant) =>
            !linked.some(
              (row) =>
                row.organizationId === grant.organizationId &&
                row.id === grant.groupId,
            ),
        )
      )
        throw new WorkflowNotFoundError('A sharing principal is unavailable');
      await replaceFolderGrants(
        client,
        scope.workspaceId,
        input.folderId,
        request,
      );
      return {
        result: await readFolderSharing(client, scope, input.folderId),
        audit: {
          action: 'workflow.folder_sharing_changed',
          targetId: input.folderId,
          metadata: {
            mode: request.mode,
            principals: request.grants.length,
            previousGrants: folderGrantDigest(current.grants),
            grants: folderGrantDigest(request.grants),
            revision: current.revision + 1,
          },
        },
      };
    },
  });
  return { ...outcome.result, replayed: outcome.replayed };
}
