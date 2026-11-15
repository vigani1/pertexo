import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';

import { createOrganizationSession } from '../session.js';
import type {
  CreateTagInput,
  DeleteTagInput,
  DetachTagInput,
  ListTagAssignmentsInput,
  ListTagsInput,
  RenameTagInput,
  ReplaceTagsInput,
} from './workflow-tag.types.js';

import { replaceWorkflowTags, detachTag } from './commands/tag-commands.js';
import {
  createTag,
  renameTag,
  deleteTagCommand,
} from './commands/tag-commands.js';
import { listTags } from './list.repository.js';
import { listTagAssignments } from './list-assignments.js';

export type WorkflowTagStore = ReturnType<typeof createWorkflowTagStore>;

export function createWorkflowTagStore(
  config: DatabaseConfig,
  options: Readonly<{ runtime?: DatabaseRuntime }> = {},
) {
  const session = createOrganizationSession(config, options.runtime);

  return Object.freeze({
    listTags: (input: ListTagsInput) => listTags(session, input),
    listTagAssignments: (input: ListTagAssignmentsInput) =>
      listTagAssignments(session, input),

    createTag: (input: CreateTagInput) => createTag(session, input),

    renameTag: (input: RenameTagInput) => renameTag(session, input),

    deleteTag: (input: DeleteTagInput) => deleteTagCommand(session, input),

    replaceTags: (input: ReplaceTagsInput) =>
      replaceWorkflowTags(session, input),

    detachTag: (input: DetachTagInput) => detachTag(session, input),

    close: session.close,
  });
}
