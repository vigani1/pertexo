import type { PoolClient } from 'pg';
import { FailureNotificationDestinationError } from './notification-destination.errors.js';
import type { FailureNotificationDestinationRecord } from './notification-destination.types.js';
import {
  lockDestination,
  readDestinationRecord,
} from './notification-destinations.repository.js';

export async function readFailureNotificationDestination(
  client: PoolClient,
  workspaceId: string,
  destinationId: string,
  { lock = false }: Readonly<{ lock?: boolean | undefined }> = {},
): Promise<FailureNotificationDestinationRecord> {
  if (lock && !(await lockDestination(client, workspaceId, destinationId)))
    throw new FailureNotificationDestinationError(
      'not_found',
      'Destination is not visible',
    );
  const row = await readDestinationRecord(client, workspaceId, destinationId);
  if (row === undefined)
    throw new FailureNotificationDestinationError(
      'not_found',
      'Destination is not visible',
    );
  return row;
}
