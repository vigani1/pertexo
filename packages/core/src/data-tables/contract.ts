import type {
  DataTableDefinition,
  DataTableExportQuery,
  DataTableSchemaEdit,
  DataTablesResponse,
} from '@pertexo/contracts';
import type {
  DataTableBindings,
  DataTableCommand,
  DataTableNewColumn,
  DataTableQuery,
  DataTableValues,
} from '@pertexo/node-sdk';
import type { ExecutionCapabilityScope } from '../attempts/dispatch/contract.js';
import type { WorkspaceActor } from '../shared/workspace-access.js';

export type { DataTableDefinition } from '@pertexo/contracts';
export type DataTableQuotas = DataTablesResponse['quotas'];
export type DataTableMutation = WorkspaceActor &
  Readonly<{ idempotencyKey: string }>;
export type DataTableWriteCommand = Exclude<
  DataTableCommand,
  { operation: 'find' }
>;

export type CreateTableInput = DataTableMutation &
  Readonly<{
    name: string;
    columns: readonly DataTableNewColumn[];
    keyColumn?: string | null;
  }>;

export type EditTableSchemaInput = DataTableMutation &
  DataTableSchemaEdit &
  Readonly<{ tableId: string }>;

export type RemoveTableInput = DataTableMutation &
  Readonly<{ tableId: string; expectedRevision: number }>;

export type ConfigureTablesInput = DataTableMutation &
  Readonly<{
    tableLimit: number;
    columnLimit: number;
    rowLimit: number;
    byteLimit: number;
  }>;

export type ExportTableInput = WorkspaceActor &
  Readonly<{
    tableId: string;
    query: DataTableExportQuery;
    consume: (
      csv: AsyncIterable<string>,
      table: DataTableDefinition,
    ) => Promise<void>;
  }>;

export type FindRowsInput = WorkspaceActor &
  Readonly<{ tableId: string; query: DataTableQuery }>;

/** Naming a row takes its revision too; otherwise the command's filter picks the rows. */
export type WriteRowsInput = DataTableMutation &
  Readonly<{ tableId: string; command: DataTableWriteCommand }> &
  (
    | Readonly<{ rowId?: undefined; expectedRevision?: undefined }>
    | Readonly<{ rowId: string; expectedRevision: number }>
  );

export type ImportRowsInput = DataTableMutation &
  Readonly<{ tableId: string }> &
  (
    | Readonly<{ rows: readonly DataTableValues[] }>
    | Readonly<{
        csv: string;
        prepareRows: (table: DataTableDefinition) => readonly DataTableValues[];
      }>
  );

export type DataTableAttempt = ExecutionCapabilityScope;

export type ExecuteTableCommandInput = DataTableAttempt &
  Readonly<{
    command: DataTableCommand;
    columnBindings?: DataTableBindings;
    signal: AbortSignal;
  }>;
