import type {
  CollaborationContext,
  WorkflowCollaborationStore,
} from './contract.js';
import { collaborationReads } from './reads.js';
import { collaborationCommands } from './commands.js';
import { collaborationPresence } from './presence.js';
export function createWorkflowCollaborationStore(
  context: CollaborationContext,
): WorkflowCollaborationStore {
  return Object.freeze({
    ...collaborationReads(context),
    ...collaborationCommands(context),
    ...collaborationPresence(context),
  });
}
