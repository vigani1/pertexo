import { capabilityGuard } from '../workspaces/http/guards.js';

export const GOVERNANCE_AUTHORIZATION = Symbol('GOVERNANCE_AUTHORIZATION');
const GOVERNANCE_STATUSES = [
  'active',
  'suspended',
  'pending_deletion',
] as const;
export const GovernanceGuard = capabilityGuard(
  GOVERNANCE_AUTHORIZATION,
  'audit:read',
  { disclosure: 'not_found', allowedWorkspaceStatuses: GOVERNANCE_STATUSES },
);
export const GovernanceManageGuard = capabilityGuard(
  GOVERNANCE_AUTHORIZATION,
  'governance:manage',
  { disclosure: 'not_found', allowedWorkspaceStatuses: GOVERNANCE_STATUSES },
);
