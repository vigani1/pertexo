export {
  withWorkspaceAccess,
  type WorkspaceAccess,
  type WorkspaceActor,
  type WorkspaceVisibility,
} from './workspace-access.js';

// Other areas import these files directly (ADR 091); the door gains nothing.
export type {} from './authority.queries.js';
export type {} from './contract.js';
export type {} from './errors.js';
export type {} from './facts.queries.js';
export type {} from './folder-policy.js';
export type {} from './scope.queries.js';
