export type EngineErrorCode =
  | 'checkpoint_invalid'
  | 'checkpoint_unsupported'
  | 'graph_invalid'
  | 'executable_invalid'
  | 'observation_invalid'
  | 'attempt_invalid'
  | 'attempt_aborted'
  | 'workflow_identity_invalid'
  | 'transition_invalid'
  | 'join_invalid'
  | 'join_unsatisfied'
  | 'loop_limit_exceeded'
  | 'loop_state_invalid';

export class WorkflowEngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowEngineError';
  }
}
