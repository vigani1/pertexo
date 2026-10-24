import { readSharingPrincipals } from '../../../tenant-access/resources/principals.queries.js';
import {
  readFolderSharing,
  replaceFolderSharing,
} from '../sharing/grants.repository.js';

import type { DatabaseConfig } from '../../../config.js';
import type { DatabaseRuntime } from '../../../platform/pool/runtime.js';

import {
  createOrganizationSession,
  type OrganizationRequestScope,
} from '../session.js';
import type { WorkflowFolderDatabase } from './contract.js';
import { uuid } from './input.js';

import {
  createFolder,
  renameFolder,
  moveFolder,
  deleteFolder,
} from './commands/mutations.repository.js';
import {
  reviewFolderMove,
  placeWorkflow,
} from './commands/placement.repository.js';
import { listFolders } from './list.queries.js';

export function createWorkflowFolderDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowFolderDatabase {
  const session = createOrganizationSession(config, options.runtime);

  const store: WorkflowFolderDatabase = {
    sharingPrincipals: (input) => {
      return session.transact(input, (client, scope) =>
        readSharingPrincipals(client, scope, input.query),
      );
    },
    readSharing: (input) => {
      return session.transact(input, (client, scope) =>
        readFolderSharing(client, scope, uuid.parse(input.folderId)),
      );
    },
    replaceSharing: (input) => {
      return session.transact(input, (client, scope) =>
        replaceFolderSharing(client, scope, {
          ...input,
          folderId: uuid.parse(input.folderId),
        }),
      );
    },
    reviewMove: (input) => reviewFolderMove(session, input),
    listFolders: (input: OrganizationRequestScope) =>
      listFolders(session, input),

    createFolder: (input) => createFolder(session, input),

    renameFolder: (input) => renameFolder(session, input),

    moveFolder: (input) => moveFolder(session, input),

    deleteFolder: (input) => deleteFolder(session, input),

    placeWorkflow: (input) => placeWorkflow(session, input),

    close: session.close,
  };
  return Object.freeze(store);
}
