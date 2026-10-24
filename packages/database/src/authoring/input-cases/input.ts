import { z } from 'zod';
import { inspectJsonValue, normalizedJson } from '@pertexo/workflow-model';
import { serializeStoredExecutionJsonValue } from '../../platform/stored-execution-value.js';

export const scopeSchema = z.object({
  workspaceId: z.uuid(),
  actorId: z.uuid(),
  workflowId: z.uuid(),
  signal: z.instanceof(AbortSignal).optional(),
});

export const revisionSchema = z.number().int().positive().max(2_147_483_646);

export const resultSchema = z
  .object({ caseId: z.uuid(), revision: revisionSchema })
  .strict();

export function payload(value: unknown): { text: string; bytes: number } {
  serializeStoredExecutionJsonValue(value);
  const inspection = inspectJsonValue(value);
  const inputExceedsLimits =
    inspection.bytes > 65_536 ||
    inspection.depth > 64 ||
    inspection.members > 10_000;
  if (inputExceedsLimits)
    throw new TypeError('Run-input case JSON exceeds its bounds');
  // The case keeps its fields in the order they were written.
  const text = normalizedJson(value);
  return { text, bytes: inspection.bytes };
}
