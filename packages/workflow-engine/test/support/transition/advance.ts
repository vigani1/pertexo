import {
  advanceWorkflow as advanceWorkflowAtSeam,
  invocationKey,
  type AdvanceWorkflowInput,
} from '../engine.js';
import { checkpoint, withExplicitSchedulerState } from '../advance-workflow.js';
export const joinKey = (nodeId: string) =>
  invocationKey({ workflowVersionId: checkpoint().workflowVersionId, nodeId });
export function advanceWorkflow(input: AdvanceWorkflowInput) {
  return advanceWorkflowAtSeam(withExplicitSchedulerState(input));
}
