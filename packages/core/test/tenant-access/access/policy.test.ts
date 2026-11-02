import { API_TOKEN_SCOPES, ROLES, hasCapability } from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';

import { isActiveMemberManager } from '../../../src/tenant-access/members/manager.js';
import {
  availableApiTokenScopes,
  tokenOwnerMayAct,
} from '../../../src/tenant-access/tokens/policy.js';

describe('tokenOwnerMayAct', () => {
  const standing = {
    userStatus: 'active',
    membershipStatus: 'active',
  } as const;

  it.each([
    ['active', 'create', true],
    ['active', 'read', true],
    ['active', 'revoke', true],
    ['suspended', 'create', false],
    ['suspended', 'read', true],
    ['suspended', 'revoke', true],
    ['pending_deletion', 'create', false],
    ['pending_deletion', 'read', true],
    ['pending_deletion', 'revoke', true],
    ['purging', 'create', false],
    ['purging', 'read', false],
    ['purging', 'revoke', false],
    ['deleted', 'create', false],
    ['deleted', 'read', false],
    ['deleted', 'revoke', false],
    [undefined, 'create', false],
    [undefined, 'read', false],
    [undefined, 'revoke', false],
  ] as const)('on a workspace %s, %s is %s', (workspaceStatus, mode, allowed) => {
    expect(tokenOwnerMayAct(mode, { ...standing, workspaceStatus })).toBe(
      allowed,
    );
  });

  it.each(['create', 'read', 'revoke'] as const)(
    'refuses %s to an inactive user or membership, or none at all',
    (mode) => {
      for (const facts of [
        { userStatus: 'suspended', membershipStatus: 'active' },
        { userStatus: undefined, membershipStatus: 'active' },
        { userStatus: 'active', membershipStatus: 'suspended' },
        { userStatus: 'active', membershipStatus: 'removed' },
        { userStatus: 'active', membershipStatus: undefined },
      ])
        expect(
          tokenOwnerMayAct(mode, { ...facts, workspaceStatus: 'active' }),
        ).toBe(false);
    },
  );
});

describe('availableApiTokenScopes', () => {
  it('offers a viewer only what reads', () => {
    const scopes = availableApiTokenScopes('viewer');
    expect(scopes).toContain('workflow:read');
    expect(scopes).not.toContain('run:cancel');
  });

  it.each(ROLES)('offers a %s exactly the scopes its role can do', (role) => {
    expect(availableApiTokenScopes(role)).toEqual(
      API_TOKEN_SCOPES.filter((scope) => hasCapability(role, scope)),
    );
  });

  it('never offers a role more than the owner has', () => {
    const owner = new Set(availableApiTokenScopes('owner'));
    for (const role of ROLES)
      for (const scope of availableApiTokenScopes(role))
        expect(owner.has(scope)).toBe(true);
  });
});

describe('isActiveMemberManager', () => {
  const manager = { status: 'active', user_status: 'active' } as const;

  it.each(['owner', 'admin'] as const)('accepts an active %s', (role) => {
    expect(isActiveMemberManager({ ...manager, role })).toBe(true);
  });

  it.each(['builder', 'operator', 'viewer'] as const)(
    'refuses a %s, however active',
    (role) => {
      expect(isActiveMemberManager({ ...manager, role })).toBe(false);
    },
  );

  it('refuses an owner whose membership or user is not active, and no member at all', () => {
    expect(
      isActiveMemberManager({ ...manager, role: 'owner', status: 'suspended' }),
    ).toBe(false);
    expect(
      isActiveMemberManager({
        ...manager,
        role: 'owner',
        user_status: 'suspended',
      }),
    ).toBe(false);
    expect(isActiveMemberManager(undefined)).toBe(false);
  });
});
