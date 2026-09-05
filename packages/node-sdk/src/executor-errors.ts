import { z } from 'zod';

import type { DefinitionIdentity, ExecutorIdentity } from './release.js';

export type NodeExecutorErrorKind =
  | 'authentication'
  | 'canceled'
  | 'configuration'
  | 'internal'
  | 'network'
  | 'provider'
  | 'rate_limit'
  | 'timeout';

export type NodeExecutorFailureOutcome = Readonly<{
  kind: 'failed' | 'canceled' | 'retry' | 'outcome_unknown';
  errorKind: NodeExecutorErrorKind;
  possiblyDispatched: boolean;
}>;

const nodeExecutorFailureSchema = z
  .object({
    kind: z.enum(['failed', 'canceled', 'retry', 'outcome_unknown']),
    errorKind: z.enum([
      'authentication',
      'canceled',
      'configuration',
      'internal',
      'network',
      'provider',
      'rate_limit',
      'timeout',
    ]),
    possiblyDispatched: z.boolean(),
  })
  .strict();

export class NodeExecutorFailure extends Error {
  public override readonly name: string = 'NodeExecutorFailure';
  public readonly kind: NodeExecutorFailureOutcome['kind'];
  public readonly errorKind: NodeExecutorErrorKind;
  public readonly possiblyDispatched: boolean;
  public constructor(outcome: unknown) {
    const parsed = nodeExecutorFailureSchema.safeParse(outcome);
    if (!parsed.success) throw new TypeError('Invalid node executor failure');
    super(`Node executor failed: ${parsed.data.kind}`);
    this.kind = parsed.data.kind;
    this.errorKind = parsed.data.errorKind;
    this.possiblyDispatched = parsed.data.possiblyDispatched;
  }
}

export class ProviderExecutionRateLimitError extends Error {
  public override readonly name = 'ProviderExecutionRateLimitError';
  public constructor(readonly retryAfterSeconds: number) {
    if (
      !Number.isSafeInteger(retryAfterSeconds) ||
      retryAfterSeconds < 1 ||
      retryAfterSeconds > 60
    )
      throw new TypeError('Invalid provider rate-limit retry duration');
    super('Provider execution rate limit reached');
  }
}

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

export class NodeRegistryCompatibilityError extends NodeSdkError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('registry_compatibility', message, details);
    this.name = 'NodeRegistryCompatibilityError';
  }
}

export class DefinitionNotFoundError extends NodeSdkError {
  constructor(readonly definition: DefinitionIdentity) {
    super(
      'definition_not_found',
      `definition ${definition.key}@${String(definition.version)} is not in the release`,
    );
    this.name = 'DefinitionNotFoundError';
  }
}

export class ExecutorNotFoundError extends NodeSdkError {
  constructor(readonly executor: ExecutorIdentity) {
    super(
      'executor_not_found',
      `executor ${executor.key}@${String(executor.version)} is not in the release`,
    );
    this.name = 'ExecutorNotFoundError';
  }
}

export class NodeExecutionAbortedError extends NodeSdkError {
  constructor() {
    super('aborted', 'node execution was canceled before it started');
    this.name = 'NodeExecutionAbortedError';
  }
}

export class NodeConfigValidationError extends NodeSdkError {
  constructor(override readonly cause: unknown) {
    super(
      'invalid_config',
      'node configuration does not match its versioned schema',
    );
    this.name = 'NodeConfigValidationError';
  }
}

export class NodeInputValidationError extends NodeSdkError {
  constructor(override readonly cause: unknown) {
    super('invalid_input', 'node input does not match its versioned schema');
    this.name = 'NodeInputValidationError';
  }
}

export class NodeOutputValidationError extends NodeSdkError {
  constructor(override readonly cause: unknown) {
    super('invalid_output', 'node output does not match its versioned schema');
    this.name = 'NodeOutputValidationError';
  }
}

export class InvalidBoundedJsonError extends NodeSdkError {
  constructor(override readonly cause: string) {
    super('invalid_json', cause);
    this.name = 'InvalidBoundedJsonError';
  }
}

export class NodeExecutionRuntimeRequiredError extends NodeSdkError {
  constructor() {
    super(
      'runtime_required',
      'dispatch-aware executor requires a node execution runtime',
    );
    this.name = 'NodeExecutionRuntimeRequiredError';
  }
}

export class NodeDispatchEvidenceError extends NodeSdkError {
  constructor(
    code:
      | 'dispatch_evidence_missing'
      | 'duplicate_dispatch'
      | 'provider_connection_fence_failed'
      | 'provider_dispatch_binding_mismatch',
  ) {
    super(code, `node provider dispatch evidence failed: ${code}`);
    this.name = 'NodeDispatchEvidenceError';
  }
}
