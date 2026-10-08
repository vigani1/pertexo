import { metrics, type Meter } from '@opentelemetry/api';
import type { WorkspaceLifecycleCommandOutcome } from '@pertexo/database/lifecycle';
import type {
  OperatorMaintenanceRerunResult,
  RetentionDryRunProcessResult,
  RetentionEnforcementProcessResult,
  PreviewRetentionProcessResult,
  RetentionScheduleResult,
  RunArtifactRetentionProcessResult,
  WorkspacePurgeProcessResult,
  TransientDataReapResult,
} from '@pertexo/database/maintenance';

export const RETENTION_METRIC_NAME = Object.freeze({
  batchCount: 'pertexo.retention.batch.count',
  batchDuration: 'pertexo.retention.batch.duration',
  failureCount: 'pertexo.retention.operation.failure.count',
  failureDuration: 'pertexo.retention.operation.failure.duration',
  operatorRerunCount: 'pertexo.maintenance.operator_rerun.count',
  operatorRerunDuration: 'pertexo.maintenance.operator_rerun.duration',
  lifecycleCommandCount: 'pertexo.lifecycle_command.process.count',
  lifecycleCommandDuration: 'pertexo.lifecycle_command.process.duration',
  pageCount: 'pertexo.retention.page.count',
  purgeCount: 'pertexo.purge.batch.count',
  purgeDuration: 'pertexo.purge.batch.duration',
  rowCount: 'pertexo.retention.rows.count',
  scheduleScanCount: 'pertexo.retention.schedule.scan.count',
  scheduleWorkspaceCount: 'pertexo.retention.schedule.workspace.count',
  transientDataReapCount: 'pertexo.retention.transient_data_reap.count',
} as const);

export type RetentionOperation =
  | 'operator_rerun'
  | 'schedule'
  | 'dry_run'
  | 'enforce'
  | 'preview'
  | 'run_artifact'
  | 'workspace_purge'
  | 'transient_data_reap'
  | 'lifecycle_command';

export interface RetentionMetrics {
  recordLifecycleCommand(
    result: WorkspaceLifecycleCommandOutcome,
    durationSeconds: number,
  ): void;
  recordSchedule(
    result: RetentionScheduleResult,
    durationSeconds: number,
  ): void;
  recordTransientDataReap(
    result: TransientDataReapResult,
    durationSeconds: number,
  ): void;
  record(
    result: RetentionDryRunProcessResult | RetentionEnforcementProcessResult,
    durationSeconds: number,
    mode: 'dry_run' | 'enforce',
  ): void;
  recordFailure(operation: RetentionOperation, durationSeconds: number): void;
  recordOperatorRerun(
    result: OperatorMaintenanceRerunResult | null,
    durationSeconds: number,
  ): void;
  recordPreview(
    result: PreviewRetentionProcessResult,
    durationSeconds: number,
  ): void;
  recordRunArtifact(
    result: RunArtifactRetentionProcessResult,
    durationSeconds: number,
  ): void;
  recordWorkspacePurge(
    result: WorkspacePurgeProcessResult,
    durationSeconds: number,
  ): void;
}

function createTransientDataReapRecorder(
  meter: Meter,
  duration: ReturnType<Meter['createHistogram']>,
): RetentionMetrics['recordTransientDataReap'] {
  const reaps = meter.createCounter(
    RETENTION_METRIC_NAME.transientDataReapCount,
    {
      description: 'Expired transient rows physically removed by data class',
      unit: '{row}',
    },
  );
  return (result, durationSeconds) => {
    reaps.add(result.idempotencyRecordsDeleted, {
      data_class: 'idempotency_record',
    });
    reaps.add(result.workspaceCreationRecordsDeleted, {
      data_class: 'workspace_creation_idempotency_record',
    });
    reaps.add(result.sessionsDeleted, { data_class: 'session' });
    reaps.add(result.authenticationMailDeleted, {
      data_class: 'authentication_mail',
    });
    reaps.add(result.authenticationMailExpired, {
      data_class: 'authentication_mail_expiry',
    });
    reaps.add(result.authenticationProofsDeleted, {
      data_class: 'authentication_email_proof',
    });
    reaps.add(result.authenticationLinkAttemptsDeleted, {
      data_class: 'authentication_method_link_attempt',
    });
    reaps.add(result.authenticationLegacyAttemptsDeleted, {
      data_class: 'authentication_legacy_migration_attempt',
    });
    reaps.add(result.identitySecurityAuditDeleted, {
      data_class: 'identity_security_audit_fact',
    });
    reaps.add(result.invitationAcceptanceIntentsDeleted, {
      data_class: 'workspace_invitation_acceptance_intent',
    });
    reaps.add(result.invitationReplacementClaimsDeleted, {
      data_class: 'workspace_invitation_replacement_claim',
    });
    reaps.add(result.invitationsExpired, {
      data_class: 'workspace_invitation_expiry',
    });
    duration.record(durationSeconds, {
      mode: 'transient_data_reap',
      outcome:
        result.idempotencyRecordsDeleted +
          result.invitationAcceptanceIntentsDeleted +
          result.invitationReplacementClaimsDeleted +
          result.invitationsExpired +
          result.workspaceCreationRecordsDeleted +
          result.sessionsDeleted +
          result.authenticationMailDeleted +
          result.authenticationMailExpired +
          result.authenticationProofsDeleted +
          result.authenticationLinkAttemptsDeleted +
          result.authenticationLegacyAttemptsDeleted +
          result.identitySecurityAuditDeleted >
        0
          ? 'deleted'
          : 'idle',
      retention_kind: 'transient_data',
    });
  };
}

export function createRetentionMetrics(
  meter: Meter = metrics.getMeter('@pertexo/retention', '0.0.0'),
): RetentionMetrics {
  const batches = meter.createCounter(RETENTION_METRIC_NAME.batchCount, {
    description: 'Retention batches processed by bounded kind and outcome',
    unit: '{batch}',
  });
  const rows = meter.createCounter(RETENTION_METRIC_NAME.rowCount, {
    description: 'Retention rows examined or eligible for bounded deletion',
    unit: '{row}',
  });
  const pages = meter.createCounter(RETENTION_METRIC_NAME.pageCount, {
    description: 'Bounded retention pages processed',
    unit: '{page}',
  });
  const duration = meter.createHistogram(RETENTION_METRIC_NAME.batchDuration, {
    description:
      'Duration of one retention operation, excluding other poll work',
    unit: 's',
  });
  const scheduleScans = meter.createCounter(
    RETENTION_METRIC_NAME.scheduleScanCount,
    {
      description: 'Retention scheduling scans by bounded outcome',
      unit: '{scan}',
    },
  );
  const scheduleWorkspaces = meter.createCounter(
    RETENTION_METRIC_NAME.scheduleWorkspaceCount,
    {
      description: 'Workspaces scanned or scheduled for retention enforcement',
      unit: '{workspace}',
    },
  );
  const failures = meter.createCounter(RETENTION_METRIC_NAME.failureCount, {
    description: 'Retention worker failures attributed to the active operation',
    unit: '{failure}',
  });
  const failureDuration = meter.createHistogram(
    RETENTION_METRIC_NAME.failureDuration,
    {
      description: 'Time spent in the retention operation that failed',
      unit: 's',
    },
  );
  const purgeCount = meter.createCounter(RETENTION_METRIC_NAME.purgeCount, {
    description: 'Workspace purge processing attempts by bounded outcome',
    unit: '{attempt}',
  });
  const purgeDuration = meter.createHistogram(
    RETENTION_METRIC_NAME.purgeDuration,
    {
      description: 'Duration of one workspace purge processing attempt',
      unit: 's',
    },
  );
  const operatorRerunCount = meter.createCounter(
    RETENTION_METRIC_NAME.operatorRerunCount,
    {
      description:
        'Operator maintenance rerun processing by target and bounded outcome',
      unit: '{command}',
    },
  );
  const operatorRerunDuration = meter.createHistogram(
    RETENTION_METRIC_NAME.operatorRerunDuration,
    {
      description: 'Duration of one operator maintenance rerun poll',
      unit: 's',
    },
  );
  const lifecycleCommandCount = meter.createCounter(
    RETENTION_METRIC_NAME.lifecycleCommandCount,
    { description: 'Lifecycle command processing outcomes', unit: '{command}' },
  );
  const lifecycleCommandDuration = meter.createHistogram(
    RETENTION_METRIC_NAME.lifecycleCommandDuration,
    { description: 'Lifecycle command processing duration', unit: 's' },
  );
  const retentionMetrics: RetentionMetrics = {
    recordLifecycleCommand: (result, durationSeconds) => {
      const attributes = {
        command_type: result.status === 'idle' ? 'none' : result.commandType,
        outcome: result.status,
      };
      lifecycleCommandCount.add(1, attributes);
      lifecycleCommandDuration.record(durationSeconds, attributes);
    },
    recordSchedule: (result, durationSeconds) => {
      const attributes = {
        mode: 'schedule',
        outcome: result.scheduledCount > 0 ? 'scheduled' : 'idle',
        retention_kind: 'all',
      };
      scheduleScans.add(1, attributes);
      scheduleWorkspaces.add(result.scannedCount, {
        ...attributes,
        workspace_outcome: 'scanned',
      });
      scheduleWorkspaces.add(result.scheduledCount, {
        ...attributes,
        workspace_outcome: 'scheduled',
      });
      duration.record(durationSeconds, attributes);
    },
    recordTransientDataReap: createTransientDataReapRecorder(meter, duration),
    record: (
      result: RetentionDryRunProcessResult | RetentionEnforcementProcessResult,
      durationSeconds: number,
      mode: 'dry_run' | 'enforce',
    ) => {
      const attributes = {
        mode,
        outcome: result.status,
        retention_kind:
          result.status === 'idle' ? 'none' : result.retentionKind,
      };
      batches.add(1, attributes);
      duration.record(durationSeconds, attributes);
      if (result.status !== 'idle') {
        rows.add(result.examinedCount, {
          ...attributes,
          row_outcome: 'examined',
        });
        rows.add(result.eligibleCount, {
          ...attributes,
          row_outcome: 'eligible',
        });
        pages.add(result.pageCount, attributes);
      }
    },
    recordFailure: (operation, durationSeconds) => {
      failures.add(1, { operation });
      failureDuration.record(durationSeconds, { operation });
    },
    recordOperatorRerun: (result, durationSeconds) => {
      const knownOutcomes = new Set([
        'already_completed',
        'legal_hold',
        'lease_active',
        'not_found',
        'rerun_accepted',
      ]);
      const attributes = {
        outcome:
          result === null
            ? 'idle'
            : knownOutcomes.has(result.outcome)
              ? result.outcome
              : 'unknown',
        target_type: result?.targetType ?? 'none',
      };
      operatorRerunCount.add(1, attributes);
      operatorRerunDuration.record(durationSeconds, attributes);
    },
    recordPreview: (
      result: PreviewRetentionProcessResult,
      durationSeconds: number,
    ) => {
      const attributes = {
        mode: 'enforce',
        outcome: result.status,
        retention_kind: 'preview',
      };
      batches.add(1, attributes);
      duration.record(durationSeconds, attributes);
      if (result.status !== 'idle') pages.add(1, attributes);
    },
    recordRunArtifact: (result, durationSeconds) => {
      const attributes = {
        mode: 'enforce',
        outcome: result.status,
        retention_kind: 'run_artifact',
      };
      batches.add(1, attributes);
      duration.record(durationSeconds, attributes);
      if (result.status !== 'idle') pages.add(1, attributes);
    },
    recordWorkspacePurge: (result, durationSeconds) => {
      const attributes = { outcome: result.status };
      purgeCount.add(1, attributes);
      purgeDuration.record(durationSeconds, attributes);
    },
  };
  return Object.freeze(retentionMetrics);
}
