import type { Role } from '@pertexo/workflow-model';

export type MembershipAddition = Readonly<
  { userId: string; role: Role } & (
    | { source: 'workspace_creation' }
    | { source: 'invitation'; invitationId: string }
    | { source: 'jit'; organizationId: string }
    | {
        source: 'directory';
        organizationId: string;
        directoryUserId: string;
        credentialId?: string;
      }
  )
>;

export type MembershipChange = Readonly<{
  userId: string;
  role: Role;
  status: 'active' | 'suspended' | 'removed';
  roleRevision: number;
}>;
