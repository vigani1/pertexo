import { NodeExecutorFailure } from '../execution/node-execution.errors.js';
import type {
  CodeDiagnostics,
  CodeErrorCode,
} from './code-protocol.schemas.js';

/** Only the closed code is public failure evidence; diagnostics stay private. */
export class NodeCodeFailure extends NodeExecutorFailure {
  public override readonly name = 'NodeCodeFailure';
  public constructor(
    readonly code: CodeErrorCode,
    readonly diagnostics: CodeDiagnostics,
  ) {
    super({
      kind: code === 'code.runner_unavailable' ? 'retry' : 'failed',
      errorKind: errorKind(code),
      possiblyDispatched: false,
      safeErrorCode: code,
    });
  }
}

function errorKind(code: CodeErrorCode) {
  // A busy runner already made the step wait its whole limit; retrying would
  // only wait again, so it fails like a timeout.
  if (code === 'code.timeout' || code === 'code.runner_busy') return 'timeout';
  // The runner is the service that runs the step: a crashed or unreachable one
  // is the kind the engine's retry policy retries, which 'internal' never is.
  if (code === 'code.runner_unavailable') return 'provider';
  const runtimeFailed =
    code === 'code.runtime_error' ||
    code === 'code.interrupted' ||
    code === 'code.memory_limit';
  if (runtimeFailed) return 'internal';
  return 'configuration';
}

/** CODE_RUNNER_SOCKET (or its default) isn't an absolute Unix socket path that fits. */
export class CodeRunnerSocketPathError extends Error {
  public override readonly name = 'CodeRunnerSocketPathError';
}
