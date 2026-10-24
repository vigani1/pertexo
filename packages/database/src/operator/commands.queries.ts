import { z } from 'zod';

import type { operatorCommands } from '../schema/runs/operator.js';

import type { OperatorCommandRecord } from './contract.js';

const persistedDateSchema = z
  .union([z.date(), z.string()])
  .pipe(z.coerce.date());

export function commandRecord(
  row: typeof operatorCommands.$inferSelect,
): OperatorCommandRecord {
  const result = row.result;
  return Object.freeze({
    commandId: row.id,
    commandType: row.commandType,
    completedAt: row.completedAt === null ? null : new Date(row.completedAt),
    createdAt: new Date(row.createdAt),
    dryRun: row.dryRun,
    outcome: row.outcome,
    priorErrorCode: z
      .string()
      .nullable()
      .parse(result.priorErrorCode ?? null),
    priorFailedAt: persistedDateSchema
      .nullable()
      .parse(result.priorFailedAt ?? null),
    priorPublishAttempts: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .parse(result.priorPublishAttempts ?? null),
    result: Object.freeze(result),
    requestFingerprint: row.requestFingerprint,
    status: row.status,
  });
}
