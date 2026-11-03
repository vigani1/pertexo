import { appSchema } from '../namespace.js';

export const workspaceInboxRevisionSequence = appSchema.sequence(
  'workspace_inbox_revision_seq',
);
