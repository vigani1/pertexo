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
      errorKind:
        code === 'code.timeout'
          ? 'timeout'
          : code === 'code.runtime_error' ||
              code === 'code.memory_limit' ||
              code === 'code.runner_unavailable'
            ? 'internal'
            : 'configuration',
      possiblyDispatched: false,
      safeErrorCode: code,
    });
  }
}
