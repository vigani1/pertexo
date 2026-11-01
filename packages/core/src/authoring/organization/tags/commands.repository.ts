import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';

import { createOrganizationSession } from '../session.js';
import type { WorkflowTagDatabase } from './contract.js';

import {
  createTag,
  renameTag,
  deleteTagCommand,
  replaceWorkflowTags,
  detachTag,
} from './commands/mutations.repository.js';
import { listTags, listTagAssignments } from './list.queries.js';

export function createWorkflowTagDatabase(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
): WorkflowTagDatabase {
  const session = createOrganizationSession(config, options.runtime);

  const store: WorkflowTagDatabase = {
    listTags: (input) => listTags(session, input),
    listTagAssignments: (input) => listTagAssignments(session, input),

    createTag: (input) => createTag(session, input),

    renameTag: (input) => renameTag(session, input),

    deleteTag: (input) => deleteTagCommand(session, input),

    replaceTags: (input) => replaceWorkflowTags(session, input),

    detachTag: (input) => detachTag(session, input),

    close: session.close,
  };
  return Object.freeze(store);
}
