import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
export const FILE_CREATION_ERROR_CODE = Object.freeze({
  data: 'file.create_data',
  size: 'file.create_size',
  columns: 'file.create_columns',
  storage: 'file.create_storage',
} as const);

export function refuseFileCreation(
  code: keyof typeof FILE_CREATION_ERROR_CODE,
  summary: string,
): never {
  throw new NodeExecutorFailure({
    kind: 'failed',
    errorKind: 'configuration',
    possiblyDispatched: false,
    safeErrorCode: FILE_CREATION_ERROR_CODE[code],
    errorSummary: summary,
  });
}
