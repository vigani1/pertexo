/** ADR064 bounds are product contracts, never caller-configurable quotas. */
export const WORKFLOW_ORGANIZATION_LIMITS = Object.freeze({
  tagKeyBytes: 32,
  tagsPerWorkflow: 16,
  tagsPerWorkspace: 256,
  cleanupItems: 50,
  nameQueryBytes: 128,
});

export const WORKFLOW_FOLDER_LIMITS = Object.freeze({
  nameBytes: 128,
  depth: 4,
  foldersPerWorkspace: 256,
  bulkItems: 50,
});
