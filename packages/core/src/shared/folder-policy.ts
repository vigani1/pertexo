import { ADMINISTRATIVE_ROLES } from '@pertexo/workflow-model';
import { hasCapability, type Role } from '@pertexo/workflow-model';
import type {
  FolderAccess,
  FolderFact,
  FolderScope,
  MatchingFolderGrant,
  WorkflowResourceCapability,
} from './contract.js';

export const RESOURCE_ADMINISTRATORS: readonly Role[] = ADMINISTRATIVE_ROLES;

/** A workspace's folders; the scope read refuses more, so a policy never decides on a partial tree. */
export const FOLDER_LIMIT = 256;

const isEditing = (capability: string) =>
  ['workflow:create', 'workflow:update', 'workflow:publish'].includes(
    capability,
  );

/** Highest matching grant locally; intersect every restricted ancestor. */
export function folderScope(
  workspaceId: string,
  role: Role | null,
  folders: readonly FolderFact[],
  grants: readonly MatchingFolderGrant[],
): FolderScope {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const matching = new Map<string, FolderAccess>();
  for (const grant of grants)
    if (matching.get(grant.folderId) !== 'editor')
      matching.set(grant.folderId, grant.access);
  const administrator = role !== null && RESOURCE_ADMINISTRATORS.includes(role);
  const paths = new Map<string, readonly FolderFact[]>();
  function ancestors(id: string): readonly FolderFact[] | undefined {
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    const path: FolderFact[] = [];
    let current: string | null = id;
    while (current !== null) {
      const folder = byId.get(current);
      if (folder === undefined || path.some((entry) => entry.id === current))
        return undefined;
      path.push(folder);
      current = folder.parentId;
    }
    paths.set(id, path);
    return path;
  }
  const levels = new Map<string, FolderAccess>();
  for (const folder of folders) {
    const path = ancestors(folder.id);
    if (path === undefined || role === null) continue;
    let access: FolderAccess | undefined = 'editor';
    for (const ancestor of path) {
      if (administrator || ancestor.accessMode === 'workspace') continue;
      const grant = matching.get(ancestor.id);
      if (grant === undefined) {
        access = undefined;
        break;
      }
      if (grant === 'viewer') access = 'viewer';
    }
    if (access !== undefined) levels.set(folder.id, access);
  }
  const readFolderIds = Object.freeze(
    [...levels.keys()].filter(
      () => role !== null && hasCapability(role, 'workflow:read'),
    ),
  );
  const editFolderIds = Object.freeze(
    [...levels]
      .filter(
        ([, access]) =>
          access === 'editor' &&
          role !== null &&
          hasCapability(role, 'workflow:update'),
      )
      .map(([id]) => id),
  );
  function permits(
    folderId: string | null,
    capability: WorkflowResourceCapability,
  ): boolean {
    if (role === null || !hasCapability(role, capability)) return false;
    if (folderId === null) return true;
    const access = levels.get(folderId);
    return (
      access === 'editor' || (access === 'viewer' && !isEditing(capability))
    );
  }
  return Object.freeze({
    workspaceId,
    role,
    readFolderIds,
    editFolderIds,
    permits,
    deniedFolderIds(capability) {
      return folders
        .filter((folder) => !permits(folder.id, capability))
        .map(({ id }) => id);
    },
    restrictions(folderId) {
      return folderId === null
        ? []
        : (ancestors(folderId) ?? [])
            .filter((folder) => folder.accessMode === 'restricted')
            .map(({ id }) => id);
    },
  } satisfies FolderScope);
}

/** Compare restriction identities, never today's possibly coincidental group membership. */
export function removesFolderRestriction(
  source: readonly string[],
  destination: readonly string[],
): boolean {
  return source.some((id) => !destination.includes(id));
}
