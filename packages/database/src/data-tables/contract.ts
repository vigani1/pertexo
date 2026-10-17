import type {
  DataTableWriteReceipt,
  DataTableDefinition,
  DataTablesResponse,
} from '@pertexo/contracts';
import type {
  DataTableColumn,
  DataTableValues,
  DataTableQuery,
  DataTableResult,
  DataTableCommand,
} from '@pertexo/node-sdk';
export type DataTableScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export type { DataTableDefinition } from '@pertexo/contracts';
export type DataTableQuotas = DataTablesResponse['quotas'];
export type DataTableMutation = Readonly<{ idempotencyKey: string }>;
export interface DataTablesStore {
  list(input: DataTableScope): Promise<{
    tables: readonly DataTableDefinition[];
    quotas: DataTableQuotas;
  }>;
  create(
    input: DataTableScope &
      DataTableMutation &
      Readonly<{
        name: string;
        columns: readonly DataTableColumn[];
        keyColumn?: string | null;
      }>,
  ): Promise<{ id: string }>;
  remove(
    input: DataTableScope &
      DataTableMutation &
      Readonly<{ tableId: string; expectedRevision: number }>,
  ): Promise<{ removed: true }>;
  configure(
    input: DataTableScope &
      DataTableMutation &
      Readonly<{
        tableLimit: number;
        columnLimit: number;
        rowLimit: number;
        byteLimit: number;
      }>,
  ): Promise<DataTableQuotas>;
  find(
    input: DataTableScope &
      Readonly<{ tableId: string; query: DataTableQuery }>,
  ): Promise<DataTableResult>;
  write(
    input: DataTableScope &
      DataTableMutation &
      Readonly<{
        tableId: string;
        command: Exclude<DataTableCommand, { operation: 'find' }>;
        rowId?: string;
        expectedRevision?: number;
      }>,
  ): Promise<DataTableWriteReceipt>;
  importRows(
    input: DataTableScope &
      DataTableMutation &
      Readonly<{ tableId: string; rows: readonly DataTableValues[] }>,
  ): Promise<{ affected: number }>;
  close(): Promise<void>;
}
export type DataTableAttempt = Readonly<{
  workspaceId: string;
  runId: string;
  nodeRunId: string;
  attemptId: string;
  attemptNumber: number;
  workerId: string;
  fenceToken: number;
  previewRunId?: string;
  nodeId: string;
  invocationKey: string;
}>;
export interface WorkerDataTablesStore {
  execute(
    input: DataTableAttempt &
      Readonly<{ command: DataTableCommand; signal: AbortSignal }>,
  ): Promise<DataTableResult>;
  close(): Promise<void>;
}
