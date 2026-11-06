export {
  createDataTablesStore,
  type DataTablesStore,
} from './data-tables.store.js';
export {
  createWorkerDataTablesStore,
  type WorkerDataTablesStore,
} from './worker-store.js';
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
export type { WorkspaceActor } from '../shared/workspace-access.js';

// Runs and authoring check table references directly (ADR 091).
export type {} from './columns/references.repository.js';
export type {} from './table-lookups.repository.js';

export { StoredTableDefinitionError } from './data-table.errors.js';
