import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  ACTIVE_WORKSPACE_STATUSES,
  UNPURGED_WORKSPACE_STATUSES,
  type AuthorizationCapability,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

import {
  withWorkspaceAccess,
  type WorkspaceActor,
} from '../shared/workspace-access.js';
import type {
  ConfigureTablesInput,
  CreateTableInput,
  EditTableSchemaInput,
  ExportTableInput,
  FindRowsInput,
  ImportRowsInput,
  RemoveTableInput,
  WriteRowsInput,
} from './contract.js';
import { editSchema } from './columns/edit.repository.js';
import { exportTable } from './csv/export.js';
import { listTables } from './definitions.queries.js';
import {
  configureTables,
  createTable,
  removeTable,
} from './definitions.repository.js';
import { translateTableConstraint } from './errors.js';
import { findTableRows } from './rows/find.queries.js';
import { importTableRows, writeTableRows } from './rows/write.js';

export type DataTablesStore = ReturnType<typeof createDataTablesStore>;

export function createDataTablesStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const read = <T>(
    actor: WorkspaceActor,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    withWorkspaceAccess(
      lease.pool,
      actor,
      {
        mode: 'read',
        capability: 'workspace:read',
        statuses: UNPURGED_WORKSPACE_STATUSES,
      },
      work,
    );
  const change = <T>(
    actor: WorkspaceActor,
    capability: AuthorizationCapability,
    work: (client: PoolClient) => Promise<T>,
  ) =>
    withWorkspaceAccess(
      lease.pool,
      actor,
      { mode: 'change', capability, statuses: ACTIVE_WORKSPACE_STATUSES },
      work,
    ).catch(translateTableConstraint);
  return {
    close: () => lease.close(),
    list: (actor: WorkspaceActor) =>
      read(actor, (client) => listTables(client, actor.workspaceId)),
    find: (input: FindRowsInput) =>
      read(input, (client) => findTableRows(client, input)),
    exportCsv: (input: ExportTableInput) =>
      exportTable((work) => read(input, work), input),
    create: (input: CreateTableInput) =>
      change(input, 'workflow:update', (client) => createTable(client, input)),
    editSchema: (input: EditTableSchemaInput) =>
      change(input, 'workflow:update', (client) => editSchema(client, input)),
    remove: (input: RemoveTableInput) =>
      change(input, 'workflow:update', (client) => removeTable(client, input)),
    // A workspace's limits are governance: owners and admins only.
    configure: (input: ConfigureTablesInput) =>
      change(input, 'governance:manage', (client) =>
        configureTables(client, input),
      ),
    write: (input: WriteRowsInput) =>
      change(input, 'workflow:update', (client) =>
        writeTableRows(client, input),
      ),
    importRows: (input: ImportRowsInput) =>
      change(input, 'workflow:update', (client) =>
        importTableRows(client, input),
      ),
  };
}
