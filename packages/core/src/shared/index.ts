export {
  withWorkspaceAccess,
  type WorkspaceAccess,
  type WorkspaceActor,
  type WorkspaceVisibility,
} from './workspace-access.js';

// Other areas import these files directly (ADR 091); the door gains nothing.
export type {} from './authority.repository.js';
export type {} from './folder-access.types.js';
export type {} from './workspace-access.errors.js';
export type {} from './facts.repository.js';
export type {} from './folder-policy.js';
export type {} from './receipts.js';
export type {} from './scope.repository.js';
export type {} from './stored-values.js';
export type {} from './stored-execution.js';
export type {} from './workspace-fence.repository.js';
export type {} from './command-receipt.errors.js';
