import { createCheckpoint } from '@pertexo/workflow-engine';

export const STORED_CHECKPOINT = createCheckpoint({
  workflowVersionId: '33333333-3333-4333-8333-333333333333',
  iterationBudget: 0,
  nextEventSequence: 2,
});
