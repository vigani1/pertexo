import type { Role } from '@pertexo/workflow-model';

export type DirectoryRole = Exclude<Role, 'owner'>;
export type DirectoryEmail = Readonly<{
  value: string;
  type?: string;
  primary: boolean;
}>;
export type DirectoryUserProfile = Readonly<{
  displayName?: string;
  name?: Readonly<{
    formatted?: string;
    familyName?: string;
    givenName?: string;
    middleName?: string;
    honorificPrefix?: string;
    honorificSuffix?: string;
  }>;
  /** The canonical primary address is first; only verified SSO may bind it. */
  emails: readonly [DirectoryEmail, ...DirectoryEmail[]];
}>;
export type DirectoryUserValues = Readonly<{
  userName: string;
  externalId: string | null;
  active: boolean;
  profile: DirectoryUserProfile;
}>;
export type DirectoryGroupValues = Readonly<{
  displayName: string;
  externalId: string | null;
  memberIds: readonly string[];
}>;
export type DirectoryPrincipal = Readonly<{
  credentialId: string;
  organizationId: string;
  controlWorkspaceId: string;
}>;
export type {
  DirectoryUserRecord as DirectoryUserRow,
  DirectoryGroupRecord as DirectoryGroupRow,
} from './resources/records.queries.js';
export type DirectoryMapping = Readonly<{
  groupId: string;
  workspaceId: string;
  role: DirectoryRole;
  priority: number;
}>;
export class DirectoryError extends Error {
  override readonly name = 'DirectoryError';
  constructor(
    readonly reason:
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'stale'
      | 'limit'
      | 'invalid_value'
      | 'invalid_filter'
      | 'invalid_path'
      | 'no_target'
      | 'mutability'
      | 'uniqueness'
      | 'owner_protected',
  ) {
    super('Directory operation is not permitted');
  }
}
