import type { AuthoringAccess } from '../workflows/access.js';
import { createCollaborationEntry } from './authority.repository.js';
import { collaborationCommands } from './comment-commands.repository.js';
import { collaborationPresence } from './presence.repository.js';
import { collaborationReads } from './comment-reads.repository.js';

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
