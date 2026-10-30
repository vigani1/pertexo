import { z } from 'zod';

import type {
  DefinitionIdentity,
  ExecutorIdentity,
} from '../definitions/catalog.js';

export const NODE_EXECUTOR_FAILURE_KINDS = Object.freeze([
  'failed',
  'canceled',
  'retry',
  'outcome_unknown',
] as const);
export const NODE_EXECUTOR_ERROR_KINDS = Object.freeze([
  'authentication',
  'canceled',
  'configuration',
  'internal',
  'network',
  'provider',
  'rate_limit',
  'timeout',
] as const);
/** The longest wait before a retry, whether a service or a step asks for it. */
export const MAXIMUM_RETRY_DELAY_MILLIS = 60_000;

export type NodeExecutorFailureKind =
  (typeof NODE_EXECUTOR_FAILURE_KINDS)[number];
export type NodeExecutorErrorKind = (typeof NODE_EXECUTOR_ERROR_KINDS)[number];

export type NodeExecutorFailureOutcome = Readonly<{
  kind: NodeExecutorFailureKind;
  errorKind: NodeExecutorErrorKind;
  possiblyDispatched: boolean;
  minimumRetryDelayMillis?: number;
  /** Fixed, content-free diagnostics supplied by the executor, never provider text. */
  safeErrorCode?: string;
  errorSummary?: string;
}>;

const nodeExecutorFailureSchema = z
  .object({
    kind: z.enum(NODE_EXECUTOR_FAILURE_KINDS),
    errorKind: z.enum(NODE_EXECUTOR_ERROR_KINDS),
    possiblyDispatched: z.boolean(),
    minimumRetryDelayMillis: z
      .number()
      .int()
      .min(0)
      .max(MAXIMUM_RETRY_DELAY_MILLIS)
      .optional(),
    safeErrorCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_.]*$/u)
      .optional(),
    errorSummary: z.string().min(1).max(2048).optional(),
  })
  .strict();

export class NodeExecutorFailure extends Error {
  public override readonly name: string = 'NodeExecutorFailure';
  public readonly kind: NodeExecutorFailureOutcome['kind'];
  public readonly errorKind: NodeExecutorErrorKind;
  public readonly possiblyDispatched: boolean;
  public readonly minimumRetryDelayMillis?: number;
  public readonly safeErrorCode?: string;
  public readonly errorSummary?: string;
  public constructor(outcome: unknown) {
    const parsed = nodeExecutorFailureSchema.safeParse(outcome);
    if (!parsed.success) throw new TypeError('Invalid node executor failure');
    super(`Node executor failed: ${parsed.data.kind}`);
    this.kind = parsed.data.kind;
    this.errorKind = parsed.data.errorKind;
    this.possiblyDispatched = parsed.data.possiblyDispatched;
    if (parsed.data.safeErrorCode !== undefined)
      this.safeErrorCode = parsed.data.safeErrorCode;
    if (parsed.data.errorSummary !== undefined)
      this.errorSummary = parsed.data.errorSummary;
    if (parsed.data.minimumRetryDelayMillis !== undefined)
      this.minimumRetryDelayMillis = parsed.data.minimumRetryDelayMillis;
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

export class ProviderCredentialInvalidError extends Error {
  public override readonly name = 'ProviderCredentialInvalidError';
  public constructor() {
    super('Provider credential is no longer valid');
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
      `definition ${definition.key}@${String(definition.version)} is not in the catalog`,
    );
    this.name = 'DefinitionNotFoundError';
  }
}

export class ExecutorNotFoundError extends NodeSdkError {
  constructor(readonly executor: ExecutorIdentity) {
    super(
      'executor_not_found',
      `executor ${executor.key}@${String(executor.version)} is not in the catalog`,
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
