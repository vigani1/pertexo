/**
 * Saved run-input cases: per workflow, per workspace, and the payload bytes a
 * workspace retains. A suite runs every case a workflow keeps.
 */
export const WORKFLOW_INPUT_CASE_LIMITS = Object.freeze({
  nameCharacters: 128,
  perWorkflow: 50,
  perWorkspace: 200,
  retainedBytes: 4 * 1024 * 1024,
});
