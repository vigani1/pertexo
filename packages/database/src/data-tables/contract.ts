import type { ExecutionCapabilityScope } from '../attempts/dispatch/contract.js';
import type {
  DataTableWriteReceipt,
  DataTableSchemaEdit,
  DataTableExportQuery,
  DataTableDefinition,
  DataTablesResponse,
} from '@pertexo/contracts';
import type {
  DataTableNewColumn,
  DataTableBindings,
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
        columns: readonly DataTableNewColumn[];
        keyColumn?: string | null;
      }>,
  ): Promise<{ id: string }>;
  editSchema(
    input: DataTableScope &
      DataTableMutation &
      DataTableSchemaEdit &
      Readonly<{ tableId: string }>,
  ): Promise<{ revision: number }>;
  exportCsv(
    input: DataTableScope &
      Readonly<{
        tableId: string;
        query: DataTableExportQuery;
        consume: (
          csv: AsyncIterable<string>,
          table: DataTableDefinition,
        ) => Promise<void>;
      }>,
  ): Promise<void>;
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
      }> &
      (
        | Readonly<{ rowId?: undefined; expectedRevision?: undefined }>
        | Readonly<{ rowId: string; expectedRevision: number }>
      ),
  ): Promise<DataTableWriteReceipt>;
  importRows(
    input: DataTableScope &
      DataTableMutation &
      Readonly<{ tableId: string }> &
      (
        | Readonly<{ rows: readonly DataTableValues[] }>
        | Readonly<{
            csv: string;
            prepareRows: (
              table: DataTableDefinition,
            ) => readonly DataTableValues[];
          }>
      ),
  ): Promise<{ affected: number }>;
  close(): Promise<void>;
}
export type DataTableAttempt = ExecutionCapabilityScope;
export interface WorkerDataTablesStore {
  execute(
    input: DataTableAttempt &
      Readonly<{
        command: DataTableCommand;
        columnBindings?: DataTableBindings;
        signal: AbortSignal;
      }>,
  ): Promise<DataTableResult>;
  close(): Promise<void>;
}
