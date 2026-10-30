import {
  workspaceVariableNameSchema,
  WORKSPACE_VARIABLE_LIMITS,
} from '@pertexo/workflow-model';
import { ROLES } from '@pertexo/workflow-model';
import type { AuditEvent } from '@pertexo/contracts';

// Historical writers sometimes stored free text. Expose typed facts only, never
// arbitrary strings under a familiar key (or a new writer's accidental payload).
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const IDENTITY_KEYS = [
  'workflowId',
  'versionId',
  'secretVersionId',
  'previousSecretVersionId',
  'runId',
  'invocationId',
  'userId',
  'requestId',
  'publicationRequestId',
  'invitationId',
  'organizationId',
  'directoryUserId',
  'credentialId',
] as const;
const NUMBER_KEYS = [
  'revision',
  'versionNumber',
  'affected',
  'roleRevision',
  'fromRevision',
  'toRevision',
  'auditRetentionDays',
  'columnCount',
  'changedCount',
  'tableLimit',
  'columnLimit',
  'rowLimit',
  'byteLimit',
] as const;
const changedNamesSchema = workspaceVariableNameSchema
  .array()
  .max(WORKSPACE_VARIABLE_LIMITS.count * 2);
const BOOLEAN_KEYS = [
  'reused',
  'dryRun',
  'found',
  'changedNamesTruncated',
  'requirePublishApproval',
] as const;
/** Keys whose string values `allowedAuditString` checks. */
type AuditStringKey =
  | 'actorRef'
  | 'operation'
  | 'actorKind'
  | 'source'
  | 'status'
  | 'role'
  | 'fromRole'
  | 'toRole';
const identityKeys = new Set<string>(IDENTITY_KEYS);
const numberKeys = new Set<string>(NUMBER_KEYS);
const booleanKeys = new Set<string>(BOOLEAN_KEYS);

/** The metadata keys the audit view shows. */
export type AuditViewKey =
  | (typeof IDENTITY_KEYS)[number]
  | (typeof NUMBER_KEYS)[number]
  | (typeof BOOLEAN_KEYS)[number]
  | AuditStringKey
  | 'changedNames';

export function projectAuditMetadata(
  metadata: unknown,
): AuditEvent['metadata'] {
  const result: AuditEvent['metadata'] = {};
  let legacyChangedCount: number | undefined;
  if (typeof metadata !== 'object' || metadata === null) return result;
  const entries: readonly [string, unknown][] = Object.entries(metadata);
  for (const [key, value] of entries) {
    if (key === 'changedNames') {
      const names = changedNamesSchema.safeParse(value);
      if (names.success) {
        result[key] = names.data.slice(0, WORKSPACE_VARIABLE_LIMITS.count);
        if (names.data.length > WORKSPACE_VARIABLE_LIMITS.count)
          legacyChangedCount = names.data.length;
      }
      continue;
    }
    const projected = projectAuditScalar(key, value);
    if (projected !== undefined) result[key] = projected;
  }
  if (legacyChangedCount !== undefined) {
    result.changedCount = legacyChangedCount;
    result.changedNamesTruncated = true;
  }
  return result;
}

function projectAuditScalar(
  key: string,
  value: unknown,
): string | number | boolean | undefined {
  if (numberKeys.has(key)) {
    const validNumber =
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    return validNumber ? value : undefined;
  }
  if (booleanKeys.has(key))
    return typeof value === 'boolean' ? value : undefined;
  if (typeof value !== 'string') return undefined;
  if (identityKeys.has(key)) return uuid.test(value) ? value : undefined;
  return allowedAuditString(key, value) ? value : undefined;
}

function allowedAuditString(key: string, value: string): boolean {
  switch (key) {
    case 'actorRef':
      return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(value);
    case 'operation':
      return [
        'insert',
        'upsert',
        'update',
        'delete',
        'add_column',
        'rename_column',
        'remove_column',
        'set_key',
      ].includes(value);
    case 'actorKind':
      return value === 'worker' || value === 'workflow';
    case 'source':
      return ['workspace_creation', 'invitation', 'jit', 'directory'].includes(
        value,
      );
    case 'status':
      return value === 'active' || value === 'suspended' || value === 'removed';
    case 'role':
    case 'fromRole':
    case 'toRole':
      return ROLES.some((role) => role === value);
    default:
      return false;
  }
}
