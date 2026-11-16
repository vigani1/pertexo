import type { PoolClient } from 'pg';
import type { Role } from '@pertexo/policy';
import type { ResourceActor } from '../shared/access/folder-access.types.js';
import type { ConnectionCapability } from '../shared/resources/connection-scope.repository.js';
import { ConnectionNotFoundError } from './connection.errors.js';
import { connectionVisible } from './connections.repository.js';

/** A restricted connection only exists for the members its shares and role reach. */
export async function requireVisibleConnection(
  client: PoolClient,
  actor: ResourceActor & Readonly<{ connectionId: string }>,
  role: Role,
  capability: ConnectionCapability,
): Promise<void> {
  if (!(await connectionVisible(client, actor, role, capability)))
    throw new ConnectionNotFoundError('Connection is not visible');
}
