import { describe } from 'vitest';

import { registerEndsMembershipEverySessionLike } from './workspace-membership-lifecycle/ends-membership-every-session-like.cases.js';
import { registerBlocksAccessSuspendedRestoresSame } from './workspace-membership-lifecycle/blocks-access-suspended-restores-same.cases.js';
import { registerSwapsOwnerAdminOneCommit } from './workspace-membership-lifecycle/swaps-owner-admin-one-commit.cases.js';
describe('leaving a workspace (ADR 047)', () => {
  registerEndsMembershipEverySessionLike();
});
describe('suspending and reactivating members (ADR 047)', () => {
  registerBlocksAccessSuspendedRestoresSame();
});
describe('transferring ownership (ADR 047)', () => {
  registerSwapsOwnerAdminOneCommit();
});
