import { NodeExecutorFailure } from '../execution/node-execution.errors.js';

export class NodeDataTableFailure extends NodeExecutorFailure {
  constructor(readonly code: DataTableError['code']) {
    super({
      kind: code === 'unavailable' ? 'retry' : 'failed',
      errorKind: code === 'unavailable' ? 'network' : 'configuration',
      possiblyDispatched: code === 'unavailable',
      safeErrorCode: `execution.table_${code}`,
    });
  }
}

export class DataTableError extends Error {
  override readonly name = 'DataTableError';
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_values'
      | 'quota_exceeded'
      | 'conflict'
      | 'key_conflict'
      | 'result_too_large'
      | 'unsafe_filter'
      | 'attempt_expired'
      | 'unavailable',
    message: string,
    readonly rowNumber?: number,
  ) {
    super(message);
  }
}
