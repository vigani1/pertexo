import { previewDirectoryAdoption } from './management/adoption.repository.js';
import type { DirectoryAdoptionQuery } from '@pertexo/contracts';
import type { DatabaseConfig } from '../../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../../platform/pool/runtime.js';
import type { FederationScope } from '../management/contract.js';
import { authenticateDirectory, withDirectoryRead } from './authority.repository.js';
import type {
  DirectoryPrincipal,
  DirectoryUserValues,
  DirectoryGroupValues,
} from './contract.js';
import {
  createDirectoryUser,
  changeDirectoryUser,
  deleteDirectoryUser,
  readDirectoryUser,
  type DirectoryUser,
} from './resources/users.repository.js';
import {
  createDirectoryGroup,
  changeDirectoryGroup,
  deleteDirectoryGroup,
  readDirectoryGroup,
  type DirectoryGroup,
} from './resources/groups.repository.js';
import {
  listDirectoryUsers,
  listDirectoryGroups,
  type DirectoryQuery,
} from './resources/records.queries.js';
import {
  readDirectoryManagement,
  type DirectoryCommand,
} from './management/commands.repository.js';
import {
  createDirectoryCredential,
  revokeDirectoryCredential,
} from './management/credentials.repository.js';
import {
  replaceDirectoryMappings,
  adoptDirectoryMembership,
} from './management/mappings.repository.js';
import { unlinkDirectoryWorkspace } from './management/unlink.repository.js';
import {
  projectDirectorySettings,
  listDirectoryPeople,
} from './management/settings.queries.js';
import type {
  DirectoryMappings,
  DirectoryAdopt,
  DirectoryPeopleQuery,
} from '@pertexo/contracts';

export function createDirectoryStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime),
    pool = lease.pool;
  return {
    close: () => lease.close(),
    authenticate: (organizationId: string, digest: string) =>
      authenticateDirectory(pool, organizationId, digest),
    user: (principal: DirectoryPrincipal, id: string) =>
      withDirectoryRead(pool, principal, (client) =>
        readDirectoryUser(client, principal.organizationId, id),
      ),
    group: (principal: DirectoryPrincipal, id: string) =>
      withDirectoryRead(pool, principal, (client) =>
        readDirectoryGroup(client, principal.organizationId, id),
      ),
    users: (principal: DirectoryPrincipal, query: DirectoryQuery) =>
      withDirectoryRead(pool, principal, (client) =>
        listDirectoryUsers(client, principal.organizationId, query),
      ),
    groups: (principal: DirectoryPrincipal, query: DirectoryQuery) =>
      withDirectoryRead(pool, principal, (client) =>
        listDirectoryGroups(client, principal.organizationId, query),
      ),
    createUser: (principal: DirectoryPrincipal, values: DirectoryUserValues) =>
      createDirectoryUser(pool, principal, values),
    changeUser: (
      principal: DirectoryPrincipal,
      id: string,
      expectedRevision: number | undefined,
      transform: (current: DirectoryUser) => DirectoryUserValues,
    ) =>
      changeDirectoryUser(pool, principal, {
        id,
        expectedRevision,
        transform,
      }),
    deleteUser: (
      principal: DirectoryPrincipal,
      id: string,
      expectedRevision: number | undefined,
    ) => deleteDirectoryUser(pool, principal, id, expectedRevision),
    createGroup: (
      principal: DirectoryPrincipal,
      values: DirectoryGroupValues,
    ) => createDirectoryGroup(pool, principal, values),
    changeGroup: (
      principal: DirectoryPrincipal,
      id: string,
      expectedRevision: number | undefined,
      transform: (current: DirectoryGroup) => DirectoryGroupValues,
    ) =>
      changeDirectoryGroup(pool, principal, {
        id,
        expectedRevision,
        transform,
      }),
    deleteGroup: (
      principal: DirectoryPrincipal,
      id: string,
      expectedRevision: number | undefined,
    ) => deleteDirectoryGroup(pool, principal, id, expectedRevision),
    adoption: (scope: FederationScope, query: DirectoryAdoptionQuery) =>
      readDirectoryManagement(
        pool,
        scope,
        (client, organization, { canManage }) =>
          previewDirectoryAdoption(client, organization, {
            canManage,
            query,
          }),
      ),
    settings: (scope: FederationScope) =>
      readDirectoryManagement(pool, scope, projectDirectorySettings),
    people: (scope: FederationScope, query: DirectoryPeopleQuery) =>
      readDirectoryManagement(pool, scope, (client, organization) =>
        listDirectoryPeople(client, organization.id, query),
      ),
    createCredential: (input: DirectoryCommand & Readonly<{ name: string }>) =>
      createDirectoryCredential(pool, input),
    revokeCredential: (
      input: DirectoryCommand & Readonly<{ credentialId: string }>,
    ) => revokeDirectoryCredential(pool, input),
    replaceMappings: (input: DirectoryCommand & DirectoryMappings) =>
      replaceDirectoryMappings(pool, input),
    adopt: (input: DirectoryCommand & DirectoryAdopt) =>
      adoptDirectoryMembership(pool, input),
    unlink: (
      input: DirectoryCommand & Readonly<{ targetWorkspaceId: string }>,
    ) => unlinkDirectoryWorkspace(pool, input),
  };
}
export type DirectoryStore = ReturnType<typeof createDirectoryStore>;
