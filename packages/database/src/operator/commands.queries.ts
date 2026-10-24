import { z } from 'zod';

import type { operatorCommands } from '../schema/runs/operator.js';

import {
  type OperatorCommandRecord,
  statusSchema,
  resultSchema,
} from './contract.js';

const persistedDateSchema = z
  .union([z.date(), z.string()])
  .pipe(z.coerce.date());

const commandTypeSchema = z.enum([
  'attempt.reconcile',
  'due-work.resume',
  'outbox.redispatch',
  'run.cancel',
  'run.replay',
  'trigger.reconcile',
  'unknown-outcome.record-evidence',
]);

export function commandRecord(
  row: typeof operatorCommands.$inferSelect,
): OperatorCommandRecord {
  const result = resultSchema.parse(row.result);
  return Object.freeze({
    commandId: row.id,
    commandType: commandTypeSchema.parse(row.commandType),
    completedAt:
      row.completedAt === null
        ? null
        : persistedDateSchema.parse(row.completedAt),
    createdAt: persistedDateSchema.parse(row.createdAt),
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
    status: statusSchema.parse(row.status),
  });
}
