import { withExplicitSchedulerState } from '../advance-workflow.js';
import {
  advanceWorkflow as advanceWorkflowAtSeam,
  type AdvanceWorkflowInput,
} from '../engine.js';
export function advanceWorkflow(input: AdvanceWorkflowInput) {
  return advanceWorkflowAtSeam(withExplicitSchedulerState(input));
}
