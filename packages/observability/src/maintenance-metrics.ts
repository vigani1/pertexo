import { metrics, type Meter } from '@opentelemetry/api';

import './server-only.js';

export const MAINTENANCE_METRIC_NAME = Object.freeze({
  controlLedgerReconciliation: 'pertexo.control_ledger.reconciliation.count',
  controlLedgerReconciliationDuration:
    'pertexo.control_ledger.reconciliation.duration',
  lifecycleCommandProcess: 'pertexo.lifecycle_command.process.count',
  lifecycleCommandProcessDuration: 'pertexo.lifecycle_command.process.duration',
});

export interface MaintenanceMetrics {
  recordControlLedgerReconciliation(
    outcome: 'agreed' | 'failed',
    durationSeconds: number,
  ): void;
  recordLifecycleCommand(
    commandType: 'deletion_requested' | 'deletion_restored' | 'unknown',
    outcome: 'completed' | 'failed' | 'released' | 'stale',
    durationSeconds: number,
  ): void;
}

export function createMaintenanceMetrics(
  meter: Meter = metrics.getMeter('@pertexo/maintenance', '0.0.0'),
): MaintenanceMetrics {
  const lifecycleCount = meter.createCounter(
    MAINTENANCE_METRIC_NAME.lifecycleCommandProcess,
    { description: 'Lifecycle command processing outcomes', unit: '{command}' },
  );
  const lifecycleDuration = meter.createHistogram(
    MAINTENANCE_METRIC_NAME.lifecycleCommandProcessDuration,
    { description: 'Lifecycle command processing duration', unit: 's' },
  );
  const reconciliationCount = meter.createCounter(
    MAINTENANCE_METRIC_NAME.controlLedgerReconciliation,
    {
      description: 'Restore control-ledger reconciliation outcomes',
      unit: '{reconciliation}',
    },
  );
  const reconciliationDuration = meter.createHistogram(
    MAINTENANCE_METRIC_NAME.controlLedgerReconciliationDuration,
    {
      description: 'Restore control-ledger reconciliation duration',
      unit: 's',
    },
  );

  return Object.freeze({
    recordControlLedgerReconciliation: (
      outcome: 'agreed' | 'failed',
      durationSeconds: number,
    ) => {
      const attributes = { outcome };
      reconciliationCount.add(1, attributes);
      reconciliationDuration.record(durationSeconds, attributes);
    },
    recordLifecycleCommand: (
      commandType: 'deletion_requested' | 'deletion_restored' | 'unknown',
      outcome: 'completed' | 'failed' | 'released' | 'stale',
      durationSeconds: number,
    ) => {
      const attributes = { command_type: commandType, outcome };
      lifecycleCount.add(1, attributes);
      lifecycleDuration.record(durationSeconds, attributes);
    },
  });
}
