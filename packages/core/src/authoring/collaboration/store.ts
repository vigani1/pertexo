import type { AuthoringAccess } from '../workflows/access.js';
import { createCollaborationEntry } from './authority.queries.js';
import { collaborationCommands } from './commands.repository.js';
import { collaborationPresence } from './presence.repository.js';
import { collaborationReads } from './reads.queries.js';

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
