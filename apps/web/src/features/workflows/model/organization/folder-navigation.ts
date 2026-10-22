import type { WorkflowFolder } from '@pertexo/contracts';

/** Names in the bounded current hierarchy; neither recursive workflow discovery nor authority. */
export function workflowFolderOptions(folders: readonly WorkflowFolder[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return folders.map((folder) => {
    const names = [folder.name];
    let parent = folder.parentId;
    for (let depth = 1; parent !== null && depth < 4; depth++) {
      const ancestor = byId.get(parent);
      if (ancestor === undefined) break;
      names.unshift(ancestor.name);
      parent = ancestor.parentId;
    }
    return { value: folder.id, label: names.join(' / ') };
  });
}

/** Folders one level below `parentId` (null is the top level), by name. */
export function childFolders(
  folders: readonly WorkflowFolder[],
  parentId: string | null,
): readonly WorkflowFolder[] {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .sort((first, second) =>
      first.name.localeCompare(second.name, undefined, { sensitivity: 'base' }),
    );
}

/**
 * The path from the top level down to `folderId`, outermost first. A folder
 * this person can't see ends the path, so a hidden parent is never named.
 */
export function folderTrail(
  folders: readonly WorkflowFolder[],
  folderId: string | undefined,
): readonly WorkflowFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const trail: WorkflowFolder[] = [];
  let current = folderId === undefined ? undefined : byId.get(folderId);
  while (current !== undefined && trail.length < 4) {
    trail.unshift(current);
    current =
      current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return trail;
}

/** A folder can't move into itself or anything inside it. */
export function folderMoveDestinations(
  folders: readonly WorkflowFolder[],
  moving: WorkflowFolder,
): readonly WorkflowFolder[] {
  const inside = new Set([moving.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders)
      if (
        folder.parentId !== null &&
        inside.has(folder.parentId) &&
        !inside.has(folder.id)
      ) {
        inside.add(folder.id);
        grew = true;
      }
  }
  return folders.filter((folder) => !inside.has(folder.id));
}
