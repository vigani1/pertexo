import { describe } from 'vitest';

import { registerValidatesForwardsExactMemberRoleCommand } from './use-cases/validates-forwards-exact-member-role-command.cases.js';
import { registerReusesGuardAuthorizationLifecycleOperations } from './use-cases/reuses-guard-authorization-lifecycle-operations.cases.js';
import { registerDeniesLifecycleAccessDeletedWorkspaceBefore } from './use-cases/denies-lifecycle-access-deleted-workspace-before.cases.js';
describe('identity/workspace application use cases', () => {
  registerValidatesForwardsExactMemberRoleCommand();

  registerReusesGuardAuthorizationLifecycleOperations();

  registerDeniesLifecycleAccessDeletedWorkspaceBefore();
});
