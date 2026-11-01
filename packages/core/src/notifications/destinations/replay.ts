import { z } from 'zod';
import { FailureNotificationDestinationConfigSchema } from '@pertexo/workflow-model';
import type { FailureNotificationDestinationRecord } from './contract.js';

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
  .strict()
  .refine((record) => record.kind === record.config.kind, {
    message: 'Destination kind does not match replayed configuration',
    path: ['config', 'kind'],
  });

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
  const parsed = destinationReplaySchema.parse(value);
  return Object.freeze({
    ...parsed,
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt),
  });
}
