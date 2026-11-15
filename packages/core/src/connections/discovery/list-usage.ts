import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { Role } from '@pertexo/policy';

import { readFolderScope } from '../../shared/folder-access-facts.repository.js';

import { ConnectionNotFoundError } from '../connection.errors.js';

import { requireVisibleConnection } from '../require-visible-connection.js';

import type {
  ConnectionUsagePage,
  ListConnectionUsageInput,
} from './connection-usage.types.js';
import { DEFAULT_CONNECTION_PAGE_SIZE } from './reads.repository.js';

/** The projection index pages version identities before bounded metadata joins. */
import { connectionUsagePage, usageCursorVisible } from './usage.repository.js';

export async function listConnectionUsage(
  client: PoolClient,
  input: ListConnectionUsageInput,
  role: Role,
): Promise<ConnectionUsagePage> {
  const { workspaceId, connectionId } = input;
  const limit = input.limit ?? DEFAULT_CONNECTION_PAGE_SIZE;
  const after = input.after?.workflowVersionId;
  const resources = await readFolderScope(client, input, role);
  await requireVisibleConnection(client, input, role, 'connection:read');
  if (after !== undefined) {
    if (!(await usageCursorVisible(client, input, resources, after)))
      throw new ConnectionNotFoundError(
        'Connection usage cursor is not visible',
      );
  }
  const result = await connectionUsagePage(drizzle(client), {
    workspaceId,
    connectionId,
    after,
    limit: limit + 1,
    resources,
  });
  const items = Object.freeze(
    result.slice(0, limit).map((row) =>
      Object.freeze({
        ...row,
        operationKeys: Object.freeze(row.operationKeys),
      }),
    ),
  );
  const last = items.at(-1);
  return Object.freeze({
    items,
    ...(result.length > limit && last !== undefined
      ? {
          nextCursor: Object.freeze({
            workflowVersionId: last.workflowVersionId,
          }),
        }
      : {}),
  });
}
