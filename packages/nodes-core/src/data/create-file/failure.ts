import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
export function refuseFileCreation(
  code: 'data' | 'size' | 'columns' | 'storage',
  summary: string,
): never {
  throw new NodeExecutorFailure({
    kind: 'failed',
    errorKind: 'configuration',
    possiblyDispatched: false,
    safeErrorCode: `file.create_${code}`,
    errorSummary: summary,
  });
}
