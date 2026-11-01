export {
  createWorkspaceVariablesStore,
  type WorkspaceVariablesStore,
} from './store.js';
export {
  WorkspaceVariablesConflictError,
  WorkspaceVariableUsageChangedError,
  type ReplaceWorkspaceVariablesInput,
  type VariableUsageInput,
} from './contract.js';
export type { WorkspaceActor } from '../shared/workspace-access.js';
