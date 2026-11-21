export type NodeErrorCode =
  | 'registry_compatibility'
  | 'definition_not_found'
  | 'executor_not_found'
  | 'aborted'
  | 'invalid_config'
  | 'invalid_input'
  | 'invalid_output'
  | 'invalid_json'
  | 'runtime_required'
  | 'dispatch_evidence_missing'
  | 'duplicate_dispatch'
  | 'provider_connection_fence_failed'
  | 'provider_dispatch_binding_mismatch';

export class NodeSdkError extends Error {
  constructor(
    readonly code: NodeErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'NodeSdkError';
  }
}

export class NodeExecutionAbortedError extends NodeSdkError {
  constructor() {
    super('aborted', 'node execution was canceled before it started');
    this.name = 'NodeExecutionAbortedError';
  }
}

export class NodeInputValidationError extends NodeSdkError {
  constructor(override readonly cause: unknown) {
    super('invalid_input', 'node input does not match its versioned schema');
    this.name = 'NodeInputValidationError';
  }
}

export class InvalidBoundedJsonError extends NodeSdkError {
  constructor(override readonly cause: string) {
    super('invalid_json', cause);
    this.name = 'InvalidBoundedJsonError';
  }
}
