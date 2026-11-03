import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/policy';
import { readSharingPrincipals } from '../../../tenant-access/resources/principals.repository.js';
import {
  readFolderSharing,
  replaceFolderSharing,
} from '../sharing/grants.repository.js';

import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';

import {
  createOrganizationSession,
  type OrganizationRequestScope,
} from '../session.js';
import type {
  CreateFolderInput,
  DeleteFolderInput,
  MoveFolderInput,
  PlaceWorkflowInput,
  ReadFolderSharingInput,
  RenameFolderInput,
  ReplaceFolderSharingInput,
  ReviewMoveInput,
  SharingPrincipalsInput,
} from './contract.js';

import {
  createFolder,
  deleteFolder,
  moveFolder,
  renameFolder,
} from './commands/mutations.repository.js';
import {
  placeWorkflow,
  reviewFolderMove,
} from './commands/placement.repository.js';
import { listFolders } from './list.repository.js';

export type WorkflowFolderStore = ReturnType<typeof createWorkflowFolderStore>;

export function createWorkflowFolderStore(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
) {
  const session = createOrganizationSession(config, options.runtime);

  return Object.freeze({
    sharingPrincipals: (input: SharingPrincipalsInput) => {
      return session.member(
        input,
        {
          mode: 'change',
          capability: 'governance:manage',
          statuses: BROWSABLE_WORKSPACE_STATUSES,
        },
        (client, scope) => readSharingPrincipals(client, scope, input.query),
      );
    },
    readSharing: (input: ReadFolderSharingInput) => {
      return session.read(
        input,
        'governance:manage',
        BROWSABLE_WORKSPACE_STATUSES,
        (client, scope) => readFolderSharing(client, scope, input.folderId),
      );
    },
    replaceSharing: (input: ReplaceFolderSharingInput) => {
      return session.command(input, 'governance:manage', (client, scope) =>
        replaceFolderSharing(client, scope, {
          ...input,
          folderId: input.folderId,
        }),
      );
    },
    reviewMove: (input: ReviewMoveInput) => reviewFolderMove(session, input),
    listFolders: (input: OrganizationRequestScope) =>
      listFolders(session, input),

    createFolder: (input: CreateFolderInput) => createFolder(session, input),

    renameFolder: (input: RenameFolderInput) => renameFolder(session, input),

    moveFolder: (input: MoveFolderInput) => moveFolder(session, input),

    deleteFolder: (input: DeleteFolderInput) => deleteFolder(session, input),

    placeWorkflow: (input: PlaceWorkflowInput) => placeWorkflow(session, input),

    close: session.close,
  });
}
