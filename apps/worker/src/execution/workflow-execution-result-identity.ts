// One content encoder/binding owner is shared by worker preparation and the
// actual terminal database adapter; neither hash grants execution authority.
export { createWorkflowExecutionResultIdentityV1 } from '@pertexo/database/execution';
export type { WorkflowExecutionResultIdentityInputV1 } from '@pertexo/database/execution';
