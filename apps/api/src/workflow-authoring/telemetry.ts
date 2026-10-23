import {
  measureOperation,
  NOOP_OPERATION_TELEMETRY,
  type OperationTelemetry,
} from '@pertexo/observability';
export const WORKFLOW_AUTHORING_OPERATION = Object.freeze({
  list: 'workflow.list',
  create: 'workflow.create',
  duplicate: 'workflow.duplicate',
  export: 'workflow.export',
  importPreview: 'workflow.import.preview',
  import: 'workflow.import',
  draftGet: 'workflow.draft.get',
  draftSave: 'workflow.draft.save',
  validate: 'workflow.validate',
  publish: 'workflow.publish',
  archive: 'workflow.archive',
  restore: 'workflow.restore',
  rename: 'workflow.rename',
  versionRestore: 'workflow.version.restore',
  versionsList: 'workflow.versions.list',
} as const);

export type WorkflowAuthoringOperation =
  (typeof WORKFLOW_AUTHORING_OPERATION)[keyof typeof WORKFLOW_AUTHORING_OPERATION];
export type WorkflowAuthoringOutcome = 'failed' | 'succeeded';
type WorkflowAuthoringMetricAttributes = Readonly<{
  operation: WorkflowAuthoringOperation;
  outcome: WorkflowAuthoringOutcome;
}>;

export interface WorkflowAuthoringCounter {
  add(value: number, attributes: WorkflowAuthoringMetricAttributes): void;
}

export interface WorkflowAuthoringHistogram {
  record(value: number, attributes: WorkflowAuthoringMetricAttributes): void;
}

export interface WorkflowAuthoringMeter {
  createCounter(
    name: 'pertexo.workflow_authoring.operation.count',
    options: Readonly<{ description: string; unit: '{operation}' }>,
  ): WorkflowAuthoringCounter;
  createHistogram(
    name: 'pertexo.workflow_authoring.operation.duration',
    options: Readonly<{ description: string; unit: 's' }>,
  ): WorkflowAuthoringHistogram;
}

export interface WorkflowAuthoringSpan {
  setAttribute(
    name: 'operation' | 'outcome',
    value: WorkflowAuthoringOperation | WorkflowAuthoringOutcome,
  ): void;
  end(): void;
}

export interface WorkflowAuthoringTracer {
  startActiveSpan<T>(
    name: `pertexo.workflow_authoring.${WorkflowAuthoringOperation}`,
    callback: (span: WorkflowAuthoringSpan) => Promise<T>,
  ): Promise<T>;
}

export type WorkflowAuthoringTelemetry =
  OperationTelemetry<WorkflowAuthoringOperation>;

export type WorkflowAuthoringTelemetryOptions = Readonly<{
  meter: WorkflowAuthoringMeter;
  tracer: WorkflowAuthoringTracer;
  monotonicNow?: () => number;
}>;

export function createWorkflowAuthoringTelemetry(
  options: WorkflowAuthoringTelemetryOptions,
): WorkflowAuthoringTelemetry {
  let operations: WorkflowAuthoringCounter;
  let duration: WorkflowAuthoringHistogram;
  try {
    operations = options.meter.createCounter(
      'pertexo.workflow_authoring.operation.count',
      {
        description:
          'Completed workflow authoring operations by bounded operation and outcome',
        unit: '{operation}',
      },
    );
    duration = options.meter.createHistogram(
      'pertexo.workflow_authoring.operation.duration',
      {
        description:
          'Workflow authoring operation duration by bounded operation and outcome',
        unit: 's',
      },
    );
  } catch {
    return NOOP_WORKFLOW_AUTHORING_TELEMETRY;
  }
  return Object.freeze({
    measure: <T>(
      operation: WorkflowAuthoringOperation,
      work: () => Promise<T>,
    ): Promise<T> =>
      measureOperation<T, WorkflowAuthoringSpan>({
        operation,
        work,
        monotonicNow: options.monotonicNow,
        trace: (run) =>
          options.tracer.startActiveSpan(
            `pertexo.workflow_authoring.${operation}`,
            run,
          ),
        record: ({ outcome, seconds }) => {
          const attributes = { operation, outcome } as const;
          operations.add(1, attributes);
          duration.record(seconds, attributes);
        },
      }),
  });
}

export const NOOP_WORKFLOW_AUTHORING_TELEMETRY: WorkflowAuthoringTelemetry =
  NOOP_OPERATION_TELEMETRY;
