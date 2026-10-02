import type { WorkflowFolder } from '@pertexo/contracts/schemas/workflow-authoring';

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
