import type { AuthoringAccess } from '../workflows/access.js';
import { createCollaborationEntry } from './authority.repository.js';
import { collaborationCommands } from './comment-commands.repository.js';
import { collaborationPresence } from './track-presence.js';
import { collaborationReads } from './read-comments.js';

export type WorkflowCollaborationStore = ReturnType<
  typeof createWorkflowCollaborationStore
>;

export function createWorkflowCollaborationStore(access: AuthoringAccess) {
  const enter = createCollaborationEntry(access);
  return Object.freeze({
    ...collaborationReads(enter),
    ...collaborationCommands(enter),
    ...collaborationPresence(enter),
  });
}
