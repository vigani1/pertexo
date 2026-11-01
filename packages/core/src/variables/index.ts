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

// Other areas import these files directly (ADR 091); the door gains nothing.
export type {} from './head.queries.js';
export type {} from './retention.repository.js';
export type {} from './values.queries.js';
