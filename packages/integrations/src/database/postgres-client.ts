import type { PostgresCredential } from '@pertexo/contracts';
import type { PostgresFailureCode } from '@pertexo/workflow-model';

export type PostgresResult = Readonly<{
  rows: Record<string, unknown>[];
  rowCount: number;
}>;
export type PostgresSession = Readonly<{
  requireColumns(
    schema: string,
    table: string,
    columns: readonly string[],
  ): Promise<readonly string[]>;
  requireUniqueKey(schema: string, table: string, key: string): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<PostgresResult>;
}>;
export type PostgresExecution = Readonly<{
  timeoutMillis: number;
  maxRows: number;
  signal?: AbortSignal;
  readOnly?: true;
  beforeDispatch(): Promise<void>;
}>;
export type PostgresOutcome =
  | Readonly<{ kind: 'succeeded'; result: PostgresResult }>
  | Readonly<{
      kind: 'failed';
      code: PostgresFailureCode;
      position?: number;
      ambiguous: boolean;
    }>;
export type PostgresClient = Readonly<{
  execute(
    credential: PostgresCredential,
    options: PostgresExecution,
    run: (session: PostgresSession) => Promise<PostgresResult>,
  ): Promise<PostgresOutcome>;
}>;
