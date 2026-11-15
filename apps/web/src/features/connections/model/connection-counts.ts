import type { ConnectionResponse } from '@pertexo/contracts';

/** How many connections work, need reconnecting, or were revoked. */
export type ConnectionCounts = Readonly<{
  active: number;
  reconnect: number;
  revoked: number;
}>;

/** Every status that is neither active nor revoked asks to reconnect. */
export function countByStatus(
  items: readonly Pick<ConnectionResponse, 'status'>[],
): ConnectionCounts {
  let active = 0;
  let reconnect = 0;
  let revoked = 0;
  for (const item of items) {
    if (item.status === 'active') active += 1;
    else if (item.status === 'revoked') revoked += 1;
    else reconnect += 1;
  }
  return { active, reconnect, revoked };
}
