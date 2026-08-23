import { metrics, type Attributes, type Meter } from '@opentelemetry/api';
import type { PreviewStatus } from '@pertexo/database';

export type PreviewTerminalStatus = Exclude<
  PreviewStatus,
  'queued' | 'running'
>;

export type PreviewTerminalMeasurement = Readonly<{
  mayContactProvider?: boolean;
  mayCauseExternalSideEffect?: boolean;
  outcome: PreviewTerminalStatus;
  possiblyDispatched?: boolean;
  sideEffectClass?: 'safe' | 'idempotent_with_key' | 'unsafe';
  source: 'execution' | 'reconciliation';
  usesConnection?: boolean;
}>;

export type PreviewReconciliationMeasurement = Readonly<{
  decision: 'completed' | 'duplicate' | 'redelivered' | 'rescheduled';
  outcome?: 'outcome_unknown' | 'timed_out';
}>;

export interface PreviewTelemetry {
  recordReconciliation(measurement: PreviewReconciliationMeasurement): void;
  recordTerminal(measurement: PreviewTerminalMeasurement): void;
}

export type PreviewTelemetrySink = Readonly<{
  reconciliation(measurement: PreviewReconciliationMeasurement): void;
  terminal(measurement: PreviewTerminalMeasurement): void;
}>;

/** Diagnostics are deliberately unable to change durable preview truth. */
export function createPreviewTelemetry(
  sink: PreviewTelemetrySink,
): PreviewTelemetry {
  return Object.freeze({
    recordReconciliation: (
      measurement: PreviewReconciliationMeasurement,
    ): void => {
      try {
        sink.reconciliation(measurement);
      } catch {
        // Metrics must never turn a committed database decision into a retry.
      }
    },
    recordTerminal: (measurement: PreviewTerminalMeasurement): void => {
      try {
        sink.terminal(measurement);
      } catch {
        // Metrics must never turn a committed database decision into a retry.
      }
    },
  });
}

function terminalAttributes(
  measurement: PreviewTerminalMeasurement,
): Attributes {
  return {
    outcome: measurement.outcome,
    source: measurement.source,
    ...(measurement.sideEffectClass === undefined
      ? {}
      : { side_effect_class: measurement.sideEffectClass }),
    ...(measurement.mayContactProvider === undefined
      ? {}
      : { may_contact_provider: measurement.mayContactProvider }),
    ...(measurement.mayCauseExternalSideEffect === undefined
      ? {}
      : {
          may_cause_external_side_effect:
            measurement.mayCauseExternalSideEffect,
        }),
    ...(measurement.possiblyDispatched === undefined
      ? {}
      : { possibly_dispatched: measurement.possiblyDispatched }),
    ...(measurement.usesConnection === undefined
      ? {}
      : { uses_connection: measurement.usesConnection }),
  };
}

function reconciliationAttributes(
  measurement: PreviewReconciliationMeasurement,
): Attributes {
  return {
    decision: measurement.decision,
    ...(measurement.outcome === undefined
      ? {}
      : { outcome: measurement.outcome }),
  };
}

export function createProductionPreviewTelemetry(
  meter: Meter = metrics.getMeter('@pertexo/worker.preview', '0.0.0'),
): PreviewTelemetry {
  const terminal = meter.createCounter('pertexo.preview.terminal.count', {
    description:
      'First committed preview terminal outcomes by bounded execution classification',
    unit: '{preview}',
  });
  const reconciliation = meter.createCounter(
    'pertexo.preview.reconciliation.count',
    {
      description:
        'Durable preview reconciliation decisions by bounded decision and outcome',
      unit: '{decision}',
    },
  );
  return createPreviewTelemetry({
    reconciliation: (measurement) => {
      reconciliation.add(1, reconciliationAttributes(measurement));
    },
    terminal: (measurement) => {
      terminal.add(1, terminalAttributes(measurement));
    },
  });
}
