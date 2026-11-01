import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';

import type { DataTablesStore } from './contract.js';

import {
  listTables,
  exportCsv,
  findTableRows,
} from './persistence/definitions.queries.js';
import {
  createTable,
  editSchema,
  removeTable,
  configureTables,
} from './persistence/definitions.repository.js';
import {
  writeTableRows,
  importTableRows,
} from './persistence/rows.repository.js';

export function createDataTablesStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): DataTablesStore {
  const lease = acquireDatabasePool(config, runtime);

  return {
    close: () => lease.close(),
    list: (input) => listTables(lease.pool, input),
    create: (input) => createTable(lease.pool, input),
    editSchema: (input) => editSchema(lease.pool, input),
    exportCsv: (input) => exportCsv(lease.pool, input),
    remove: (input) => removeTable(lease.pool, input),
    configure: (input) => configureTables(lease.pool, input),
    find: (input) => findTableRows(lease.pool, input),
    write: (input) => writeTableRows(lease.pool, input),
    importRows: (input) => importTableRows(lease.pool, input),
  };
}
