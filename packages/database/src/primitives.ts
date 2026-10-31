// What core areas build on: applications never import this (a check enforces it).
export { rethrowQueryFailure } from './platform/query-errors.js';
export {
  claimCommand,
  completeCommand,
} from './platform/idempotency/repository.js';
export { appendAuditFact } from './governance/audit/events.repository.js';
export {
  parseWorkspaceId,
  withTenantScopedClient,
  withTenantScopedReadClient,
  type WorkspaceTransaction,
} from './tenant-access/transactions.js';
// Until tenant-access moves: every database area still uses these.
export {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
} from './tenant-access/workspaces/authority.queries.js';
export { readBrowsableFolderScope } from './tenant-access/resources/facts.queries.js';
export { workflowScopeSql } from './tenant-access/resources/scope.queries.js';
