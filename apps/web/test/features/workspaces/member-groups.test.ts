import type { WorkspaceMember } from '@pertexo/contracts';
import { expect, it } from 'vitest';
import { groupMembers } from '@/features/workspaces/model/member-groups';

function member(
  displayName: string,
  email: string,
  role: WorkspaceMember['role'],
): WorkspaceMember {
  return {
    userId: crypto.randomUUID(),
    email,
    displayName,
    role,
    roleRevision: 1,
    membershipStatus: 'active',
    createdAt: '2026-09-14T10:00:00.000Z',
    updatedAt: '2026-09-14T10:00:00.000Z',
  };
}

const team = [
  member('Mei Chen', 'mei@example.test', 'viewer'),
  member('Dena Okafor', 'dena@example.test', 'owner'),
  member('Sami Haddad', 'sami@example.test', 'builder'),
  member('Iris Lund', 'iris@example.test', 'admin'),
];

it('groups members by role, most powerful first, and leaves out empty roles', () => {
  expect(
    groupMembers(team, '').map((group) => [
      group.role,
      group.members.map((each) => each.displayName),
    ]),
  ).toEqual([
    ['owner', ['Dena Okafor']],
    ['admin', ['Iris Lund']],
    ['builder', ['Sami Haddad']],
    ['viewer', ['Mei Chen']],
  ]);
});

it('keeps only members whose name or email holds the search, ignoring case', () => {
  expect(
    groupMembers(team, '  SAMI ').flatMap((group) =>
      group.members.map((each) => each.displayName),
    ),
  ).toEqual(['Sami Haddad']);
  expect(
    groupMembers(team, 'iris@').flatMap((group) =>
      group.members.map((each) => each.displayName),
    ),
  ).toEqual(['Iris Lund']);
  expect(groupMembers(team, 'nobody')).toEqual([]);
});
