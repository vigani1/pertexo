// What core areas build on: applications never import this (a check enforces it).
export { rethrowQueryFailure } from './platform/query-errors.js';
export {
  claimCommand,
  completeCommand,
} from './platform/idempotency/repository.js';
export { appendAuditFact } from './governance/audit/events.repository.js';
export {
  withTenantScopedClient,
  withTenantScopedReadClient,
} from './tenant-access/transactions.js';
// Until tenant-access moves: every database area still uses these.
export {
  lockWorkspaceAuthorityInStatuses,
  readWorkspaceAuthority,
} from './tenant-access/workspaces/authority.queries.js';
// Until the one-shot move: authoring and runs still lock the set too, so its one
// lock-then-read stays below them, and the replacement meets it here.
export { lockVariableSet } from './variables/head.queries.js';
export { readFolderScope } from './tenant-access/resources/facts.queries.js';
export { workflowScopeSql } from './tenant-access/resources/scope.queries.js';
