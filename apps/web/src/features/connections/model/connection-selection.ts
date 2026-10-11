import type { ConnectionResponse } from '@pertexo/contracts';

/** Unknown health is usable; only credential status and kind govern selection. */
export function isUsableConnection(
  connection: Pick<ConnectionResponse, 'authType' | 'status'>,
  requirement: string,
): boolean {
  return connection.authType === requirement && connection.status === 'active';
}
