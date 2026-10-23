import { capabilityGuard } from '../workspaces/http/guards.js';

export const GOVERNANCE_AUTHORIZATION = Symbol('GOVERNANCE_AUTHORIZATION');
export const GovernanceGuard = capabilityGuard(
  GOVERNANCE_AUTHORIZATION,
  'audit:read',
  {
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active', 'suspended', 'pending_deletion'],
  },
);
