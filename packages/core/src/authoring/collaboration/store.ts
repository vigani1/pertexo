import type {
  CollaborationContext,
  WorkflowCollaborationStore,
} from './contract.js';
import { collaborationReads } from './reads.queries.js';
import { collaborationCommands } from './commands.repository.js';
import { collaborationPresence } from './presence.repository.js';
export function createWorkflowCollaborationStore(
  context: CollaborationContext,
): WorkflowCollaborationStore {
  return Object.freeze({
    ...collaborationReads(context),
    ...collaborationCommands(context),
    ...collaborationPresence(context),
  });
}
