import {
  workspaceVariableNameSchema,
  WORKSPACE_VARIABLE_LIMITS,
} from '@pertexo/workflow-model';
import { ROLES } from '../../tenant-access/policy.js';
import type { AuditEvent } from '@pertexo/contracts';

// Historical writers sometimes stored free text. Expose typed facts only, never
// arbitrary strings under a familiar key (or a new writer's accidental payload).
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const identityKeys = new Set([
  'workflowId',
  'versionId',
  'secretVersionId',
  'previousSecretVersionId',
  'runId',
  'invocationId',
  'userId',
  'requestId',
]);
const numberKeys = new Set([
  'revision',
  'versionNumber',
  'affected',
  'roleRevision',
  'fromRevision',
  'toRevision',
  'auditRetentionDays',
  'columnCount',
  'tableLimit',
  'columnLimit',
  'rowLimit',
  'byteLimit',
]);
const changedNamesSchema = workspaceVariableNameSchema
  .array()
  .max(WORKSPACE_VARIABLE_LIMITS.count);
const booleanKeys = new Set(['reused', 'dryRun']);
export function projectAuditMetadata(
  metadata: unknown,
): AuditEvent['metadata'] {
  const result: AuditEvent['metadata'] = {};
  if (typeof metadata !== 'object' || metadata === null) return result;
  const entries: readonly [string, unknown][] = Object.entries(metadata);
  for (const [key, value] of entries) {
    if (key === 'changedNames') {
      const names = changedNamesSchema.safeParse(value);
      if (names.success) result[key] = names.data;
    } else if (
      key === 'actorRef' &&
      typeof value === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(value)
    )
      result[key] = value;
    else if (
      identityKeys.has(key) &&
      typeof value === 'string' &&
      uuid.test(value)
    )
      result[key] = value;
    else if (
      numberKeys.has(key) &&
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
    )
      result[key] = value;
    else if (booleanKeys.has(key) && typeof value === 'boolean')
      result[key] = value;
    else if (
      key === 'operation' &&
      typeof value === 'string' &&
      [
        'insert',
        'upsert',
        'update',
        'delete',
        'add_column',
        'rename_column',
        'remove_column',
        'set_key',
      ].includes(value)
    )
      result[key] = value;
    else if (
      key === 'actorKind' &&
      (value === 'worker' || value === 'workflow')
    )
      result[key] = value;
    else if (
      ['role', 'fromRole', 'toRole'].includes(key) &&
      typeof value === 'string' &&
      ROLES.some((role) => role === value)
    )
      result[key] = value;
  }
  return result;
}
