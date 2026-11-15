import assert from 'node:assert/strict';
import test from 'node:test';

import { findWorkspaceStatusLists } from './validate-workspace-status-lists.mjs';

const find = (text, file = 'apps/api/src/a.ts') =>
  findWorkspaceStatusLists(file, text);

test('refuses a planted workspace-status list in every place one is held', () => {
  for (const text of [
    "authorize({ allowedWorkspaceStatuses: ['active'] });",
    "const allowed = input.allowedWorkspaceStatuses ?? ['active'];",
    "f({ allowedWorkspaceStatuses: write ? ['active'] : BROWSABLE });",
    "function g(allowedWorkspaceStatuses = ['active', 'suspended']) {}",
    "const workspaceStatuses = ['active', 'suspended', 'pending_deletion'] as const;",
  ])
    assert.equal(find(text).length, 1, text);
});

test('leaves policy, named lists and other status vocabularies alone', () => {
  assert.deepEqual(
    find("export const ACTIVE = ['active'];", 'packages/policy/src/p.ts'),
    [],
  );
  assert.deepEqual(
    find('f({ allowedWorkspaceStatuses: ACTIVE_WORKSPACE_STATUSES });'),
    [],
  );
  assert.deepEqual(
    find("const membershipStatus = z.enum(['active', 'suspended']);"),
    [],
  );
  assert.deepEqual(find("inArray(memberships.status, ['active']);"), []);
});
