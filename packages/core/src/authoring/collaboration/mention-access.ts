import { hasCapability, type Role } from '@pertexo/policy';

/** Every mentioned person is an active member who can read the workflow. */
export function mentionsReachable(
  members: readonly Readonly<{ userId: string; role: Role }>[],
  userIds: readonly string[],
): boolean {
  return (
    members.length === userIds.length &&
    members.every((member) => hasCapability(member.role, 'workflow:read'))
  );
}
