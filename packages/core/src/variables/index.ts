export {
  createWorkspaceVariablesStore,
  type WorkspaceVariablesStore,
} from './workspace-variables.store.js';
export {
  type ReplaceWorkspaceVariablesInput,
  type VariableUsageInput,
} from './workspace-variables.types.js';
export {
  WorkspaceVariablesConflictError,
  WorkspaceVariableUsageChangedError,
} from './workspace-variables.errors.js';
export type { WorkspaceActor } from '../shared/access/workspace-access.js';

// Other areas import these files directly (ADR 091); the door gains nothing.
export type {} from './head.repository.js';
export type {} from './retention.repository.js';
export type {} from './values.repository.js';
