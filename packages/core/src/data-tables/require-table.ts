import type { PoolClient } from 'pg';
import { DataTableError } from '@pertexo/node-sdk';
import type { DataTableDefinition } from './data-table-commands.types.js';
import { findTable } from './table-lookups.repository.js';

export async function requireTable(
  client: PoolClient,
  workspaceId: string,
  identity: { id: string } | { name: string },
  { lock = false }: Readonly<{ lock?: boolean | undefined }> = {},
): Promise<DataTableDefinition> {
  const table = await findTable(client, workspaceId, identity, lock);
  if (table === undefined)
    throw new DataTableError(
      'not_found',
      'This data table is unavailable. Select an existing workspace table.',
    );
  return table;
}
