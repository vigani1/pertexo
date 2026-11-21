import { NodeSdkError } from './node-admission.errors.js';
export {
  NodeSdkError,
  type NodeErrorCode,
  NodeExecutionAbortedError,
  NodeInputValidationError,
  InvalidBoundedJsonError,
} from './node-admission.errors.js';
import type {
  DefinitionIdentity,
  ExecutorIdentity,
} from '../definitions/catalog.js';
import {
  MAXIMUM_RETRY_DELAY_MILLIS,
  nodeExecutorFailureSchema,
  type NodeExecutorErrorKind,
  type ServiceResponseFacts,
  type NodeExecutorFailureOutcome,
} from './node-failure.schemas.js';

function describeServiceResponse({
  method,
  url,
  status,
  body,
}: ServiceResponseFacts): string {
  const answered = `${method} ${url} answered ${String(status)}.`;
  switch (body.kind) {
    case 'text':
      return `${answered}\n${body.excerpt}`;
    case 'binary':
      return `${answered} The response isn’t text, so it isn’t shown here.`;
    case 'too_large':
      return `${answered} The response was too large to show here.`;
    case 'none':
      return answered;
  }
}

export class NodeExecutorFailure extends Error {
  public override readonly name: string = 'NodeExecutorFailure';
  public readonly kind: NodeExecutorFailureOutcome['kind'];
  public readonly errorKind: NodeExecutorErrorKind;
  public readonly possiblyDispatched: boolean;
  public readonly minimumRetryDelayMillis?: number;
  public readonly safeErrorCode?: string;
  public readonly errorSummary?: string;
  public readonly serviceResponse?: ServiceResponseFacts;
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
    if (parsed.data.serviceResponse !== undefined)
      this.serviceResponse = parsed.data.serviceResponse;
    if (parsed.data.minimumRetryDelayMillis !== undefined)
      this.minimumRetryDelayMillis = parsed.data.minimumRetryDelayMillis;
  }

  /** The sentence a person reads: the executor's own, or the service's answer. */
  public get shownSummary(): string | undefined {
    return (
      this.errorSummary ??
      (this.serviceResponse === undefined
        ? undefined
        : describeServiceResponse(this.serviceResponse))
    );
  }
}

export class ProviderExecutionRateLimitError extends Error {
  public override readonly name = 'ProviderExecutionRateLimitError';
  public constructor(readonly retryAfterSeconds: number) {
    if (
      !Number.isSafeInteger(retryAfterSeconds) ||
      retryAfterSeconds < 1 ||
      retryAfterSeconds * 1_000 > MAXIMUM_RETRY_DELAY_MILLIS
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

export class NodeConfigValidationError extends NodeSdkError {
  constructor(override readonly cause: unknown) {
    super(
      'invalid_config',
      'node configuration does not match its versioned schema',
    );
    this.name = 'NodeConfigValidationError';
  }
}

export class NodeOutputValidationError extends NodeSdkError {
  constructor(override readonly cause: unknown) {
    super('invalid_output', 'node output does not match its versioned schema');
    this.name = 'NodeOutputValidationError';
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
