import { connectionFitsSlot } from '@pertexo/workflow-model';
import type { ConnectionResponse } from '@pertexo/contracts';
import { providerForCredential } from './connection-providers';

/** Whether this kind of connection can serve a step that asks for `requirement`. */
export function fitsRequirement(
  connection: Pick<ConnectionResponse, 'providerKey' | 'authType'>,
  requirement: string,
): boolean {
  return connectionFitsSlot(connection, {
    providerKey: providerForCredential(requirement) ?? '',
    authType: requirement,
  });
}

/** Unknown health is usable; only credential status and kind govern selection. */
export function isUsableConnection(
  connection: Pick<ConnectionResponse, 'providerKey' | 'authType' | 'status'>,
  requirement: string,
): boolean {
  return (
    fitsRequirement(connection, requirement) && connection.status === 'active'
  );
}
