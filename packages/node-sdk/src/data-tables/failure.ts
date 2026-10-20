import { NodeExecutorFailure } from '../execution/errors.js';
import type { DataTableError } from './contract.js';
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
