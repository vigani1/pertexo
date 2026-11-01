import type { DirectoryAdopt, DirectoryMappings } from '@pertexo/contracts';
import type { Filter } from 'scim2-parse-filter';
import type { FederationCommand } from '../management/contract.js';

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
import type {
  DirectoryUserRow,
  DirectoryGroupRow,
} from './resources/records.queries.js';
export type DirectoryMapping = Readonly<{
  groupId: string;
  workspaceId: string;
  role: DirectoryRole;
  priority: number;
}>;

export type DirectoryWorkspace = Readonly<{
  workspace_id: string;
  default_role: DirectoryRole;
}>;

export type DirectoryOrganization = Readonly<{
  id: string;
  control_workspace_id: string;
  revision: number;
  workspaces: readonly DirectoryWorkspace[];
}>;

export type CreateCredentialInput = FederationCommand &
  Readonly<{ name: string }>;
export type RevokeCredentialInput = FederationCommand &
  Readonly<{ credentialId: string }>;
export type ReplaceMappingsInput = FederationCommand & DirectoryMappings;
export type AdoptMembershipInput = FederationCommand & DirectoryAdopt;
export type UnlinkWorkspaceInput = FederationCommand &
  Readonly<{ targetWorkspaceId: string }>;

export type DirectoryQuery = Readonly<{
  filter?: Filter;
  startIndex: number;
  count: number;
  sortBy?: string;
  sortOrder: 'ascending' | 'descending';
}>;

export type DirectoryPage<T> = Readonly<{
  totalResults: number;
  startIndex: number;
  Resources: readonly T[];
}>;

export type DirectoryUser = DirectoryUserRow &
  Readonly<{ groupIds: readonly string[] }>;

export type DirectoryGroup = DirectoryGroupRow &
  Readonly<{ memberIds: readonly string[] }>;
