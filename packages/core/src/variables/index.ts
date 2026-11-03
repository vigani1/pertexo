export {
  createWorkspaceVariablesStore,
  type WorkspaceVariablesStore,
} from './workspace-variables.store.js';
export {
  WorkspaceVariablesConflictError,
  WorkspaceVariableUsageChangedError,
  type ReplaceWorkspaceVariablesInput,
  type VariableUsageInput,
} from './workspace-variables.js';
export type { WorkspaceActor } from '../shared/workspace-access.js';

// Other areas import these files directly (ADR 091); the door gains nothing.
export type {} from './head.repository.js';
export type {} from './retention.repository.js';
export type {} from './values.repository.js';
