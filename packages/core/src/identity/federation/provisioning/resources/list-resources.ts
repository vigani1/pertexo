import type { PoolClient } from 'pg';
import type {
  DirectoryGroup,
  DirectoryPage,
  DirectoryQuery,
  DirectoryUser,
} from '../directory-provisioning.types.js';
import { DirectoryError } from '../directory.errors.js';
import {
  compileDirectoryFilter,
  directoryField,
  type DirectoryKind,
} from './filter.repository.js';
import {
  listRows,
  readGroupMembers,
  readUserGroupMembers,
} from './directory-resources.repository.js';

export async function listDirectoryUsers(
  client: PoolClient,
  organizationId: string,
  query: DirectoryQuery,
): Promise<DirectoryPage<DirectoryUser>> {
  const page = requireValidQuery(
    await listRows(client, organizationId, 'User', resolve('User', query)),
  );
  const members = await readUserGroupMembers(
    client,
    organizationId,
    page.Resources.map((user) => user.id),
  );
  const groups = Map.groupBy(members, (member) => member.directory_user_id);
  return {
    ...page,
    Resources: page.Resources.map((user) => ({
      ...user,
      groupIds: (groups.get(user.id) ?? []).map((member) => member.group_id),
    })),
  };
}
export async function listDirectoryGroups(
  client: PoolClient,
  organizationId: string,
  query: DirectoryQuery,
): Promise<DirectoryPage<DirectoryGroup>> {
  const page = requireValidQuery(
    await listRows(client, organizationId, 'Group', resolve('Group', query)),
  );
  const members = await readGroupMembers(
    client,
    organizationId,
    page.Resources.map((group) => group.id),
  );
  const groups = Map.groupBy(members, (member) => member.group_id);
  return {
    ...page,
    Resources: page.Resources.map((group) => ({
      ...group,
      memberIds: (groups.get(group.id) ?? []).map(
        (member) => member.directory_user_id,
      ),
    })),
  };
}

/** An unusable filter is refused before any read; an unusable sort only once rows must be ordered. */
function resolve(kind: DirectoryKind, query: DirectoryQuery) {
  const filter = compileDirectoryFilter(kind, query.filter);
  if (filter === undefined) throw new DirectoryError('invalid_filter');
  return { query, filter, sort: directoryField(kind, query.sortBy ?? 'id') };
}

function requireValidQuery<Page>(page: Page | 'invalid_sort'): Page {
  if (page === 'invalid_sort') throw new DirectoryError('invalid_filter');
  return page;
}
