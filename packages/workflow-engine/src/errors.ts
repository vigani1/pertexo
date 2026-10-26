export type EngineErrorCode =
  | 'checkpoint_invalid'
  | 'graph_invalid'
  | 'executable_invalid'
  | 'observation_invalid'
  | 'attempt_invalid'
  | 'variable_missing'
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
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowEngineError';
  }
}

/**
 * A single-step test maps another step's output that the test doesn't carry:
 * only a prior test of that step supplies it.
 */
export class PreviewMappingSourceError extends WorkflowEngineError {
  constructor(
    readonly mappingKey: string,
    readonly sourceNodeId: string,
  ) {
    super('attempt_invalid', 'preview mapping source is not the prior test');
    this.name = 'PreviewMappingSourceError';
  }
}
