import type { Role } from '@pertexo/policy';
import { CONNECTION_STATUS } from '@pertexo/workflow-model';
import type { WorkspaceActor } from '../../../shared/access/workspace-access.js';
import {
  connectionScope,
  connectionScopeSql,
} from '../../../shared/resources/connection-scope.repository.js';
import { connections, workspaces } from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

export type AssistantConnectionIdentity = Readonly<{
  providerKey: string;
  authType: string;
}>;

export type AssistantSelection = Readonly<{
  connectionId: string;
  model: string;
}>;

export async function readAssistantSelection(
  client: PoolClient,
  workspaceId: string,
): Promise<AssistantSelection | null> {
  const [row] = await drizzle(client)
    .select({
      connectionId: workspaces.assistantConnectionId,
      model: workspaces.assistantModel,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return row?.connectionId == null || row.model === null
    ? null
    : { connectionId: row.connectionId, model: row.model };
}

export async function updateAssistantSelection(
  client: PoolClient,
  workspaceId: string,
  selection: AssistantSelection | null,
): Promise<void> {
  await drizzle(client)
    .update(workspaces)
    .set({
      assistantConnectionId: selection?.connectionId ?? null,
      assistantModel: selection?.model ?? null,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(eq(workspaces.id, workspaceId));
}

export async function isAvailableAssistantConnection(
  client: PoolClient,
  actor: WorkspaceActor,
  role: Role,
  connection: AssistantConnectionIdentity & Readonly<{ connectionId: string }>,
) {
  const [row] = await drizzle(client)
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.id, connection.connectionId),
        connectionScopeSql(
          connectionScope(actor, role, 'connection:use'),
          connections,
        ),
        eq(connections.status, CONNECTION_STATUS.active),
        eq(connections.providerKey, connection.providerKey),
        eq(connections.authType, sql`${connection.authType}`),
      ),
    )
    .for('share');
  return row !== undefined;
}
