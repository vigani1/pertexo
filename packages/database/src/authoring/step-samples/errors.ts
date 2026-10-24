export class WorkflowStepSampleError extends Error {
  override readonly name = 'WorkflowStepSampleError';
  constructor(
    readonly reason:
      | 'changed'
      | 'draft_changed'
      | 'expired'
      | 'stale'
      | 'source_unavailable'
      | 'file_output'
      | 'value_invalid'
      | 'limit_reached'
      | 'step_unavailable',
  ) {
    super(`workflow.sample_${reason}`);
  }
}
