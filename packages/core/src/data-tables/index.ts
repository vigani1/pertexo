export {
  createDataTablesStore,
  type DataTablesStore,
} from './data-tables.store.js';
export {
  createWorkerDataTablesStore,
  type WorkerDataTablesStore,
} from './worker-data-tables.store.js';
export type {
  ConfigureTablesInput,
  CreateTableInput,
  DataTableAttempt,
  DataTableDefinition,
  DataTableQuotas,
  EditTableSchemaInput,
  ExportTableInput,
  FindRowsInput,
  ImportRowsInput,
  RemoveTableInput,
  WriteRowsInput,
} from './data-table-commands.types.js';
export type { WorkspaceActor } from '../shared/access/workspace-access.js';

// Runs and authoring check table references directly (ADR 091).
export type {} from './columns/references.repository.js';
export type {} from './table-lookups.repository.js';
export type {} from './columns/table-references.js';
export type {} from './require-table.js';
export type {} from './rows/find-rows.js';

export { StoredTableDefinitionError } from './data-table.errors.js';
