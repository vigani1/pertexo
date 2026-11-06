import { decodeStoredValue } from '../../shared/stored-values.js';
import { decodeStoredReceipt } from '../../shared/receipts.js';
import { z } from 'zod';
import { FailureNotificationDestinationConfigSchema } from '@pertexo/contracts';
import type { FailureNotificationDestinationRecord } from './notification-destination.types.js';

const destinationReplaySchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    kind: z.enum(['slack', 'email']),
    status: z.enum(['enabled', 'disabled']),
    currentVersion: z.number().int().positive(),
    config: FailureNotificationDestinationConfigSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export function serializeFailureNotificationDestinationRecord(
  record: FailureNotificationDestinationRecord,
) {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function decodeFailureNotificationDestinationReplay(
  value: unknown,
): FailureNotificationDestinationRecord {
  const parsed = decodeStoredReceipt(destinationReplaySchema, value);
  return decodeStoredValue(() => {
    if (parsed.kind !== parsed.config.kind)
      throw new Error('Destination kind does not match replayed configuration');
    return Object.freeze({
      ...parsed,
      createdAt: new Date(parsed.createdAt),
      updatedAt: new Date(parsed.updatedAt),
    });
  });
}
