export class WorkflowTestError extends Error {
  override readonly name = 'WorkflowTestError';
  constructor(
    readonly reason:
      | 'draft_changed'
      | 'cases_changed'
      | 'cases_required'
      | 'case_invalid'
      | 'samples_changed'
      | 'stale_sample'
      | 'pin_invalid'
      | 'not_supported'
      | 'effects_acknowledgement_required'
      | 'effects_changed'
      | 'already_running'
      | 'not_found',
  ) {
    super(`workflow.test_${reason}`);
  }
}
