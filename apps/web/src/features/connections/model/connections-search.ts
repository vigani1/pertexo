import {
  isConnectionChoice,
  type ConnectionChoice,
} from './connection-providers';

/**
 * The Connections page's URL state: which lens is open and whether revoked
 * connections are shown. Unknown or malformed values are dropped.
 */
export type ConnectionsSearch = Readonly<{
  add?: ConnectionChoice | 'any';
  connection?: string;
  view?: 'revoked';
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseConnectionsSearch(
  search: Readonly<Record<string, unknown>>,
): ConnectionsSearch {
  const { add, connection, view } = search;
  return {
    ...(add === 'any' || isConnectionChoice(add) ? { add } : {}),
    ...(typeof connection === 'string' && UUID.test(connection)
      ? { connection }
      : {}),
    ...(view === 'revoked' ? { view } : {}),
  };
}
