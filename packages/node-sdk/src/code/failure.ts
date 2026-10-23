import { NodeExecutorFailure } from '../execution/errors.js';
import type { CodeDiagnostics, CodeErrorCode } from './contract.js';

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
  if (code === 'code.timeout') return 'timeout';
  const runtimeFailed =
    code === 'code.runtime_error' ||
    code === 'code.memory_limit' ||
    code === 'code.runner_unavailable';
  if (runtimeFailed) return 'internal';
  return 'configuration';
}
