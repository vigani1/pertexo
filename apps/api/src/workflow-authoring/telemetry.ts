export const WORKFLOW_AUTHORING_OPERATION = Object.freeze({
  list: 'workflow.list',
  create: 'workflow.create',
  draftGet: 'workflow.draft.get',
  draftSave: 'workflow.draft.save',
  validate: 'workflow.validate',
  publish: 'workflow.publish',
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

export interface WorkflowAuthoringTelemetry {
  measure<T>(
    operation: WorkflowAuthoringOperation,
    work: () => Promise<T>,
  ): Promise<T>;
}

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
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  return Object.freeze({
    measure: <T>(
      operation: WorkflowAuthoringOperation,
      work: () => Promise<T>,
    ): Promise<T> => {
      try {
        return options.tracer.startActiveSpan(
          `pertexo.workflow_authoring.${operation}`,
          async (span): Promise<T> => {
            const startedAt = safeNow(monotonicNow);
            safeAttribute(span, 'operation', operation);
            try {
              const result = await work();
              record(
                'succeeded',
                operation,
                startedAt,
                safeNow(monotonicNow),
                span,
              );
              return result;
            } catch (error: unknown) {
              record(
                'failed',
                operation,
                startedAt,
                safeNow(monotonicNow),
                span,
              );
              throw error;
            } finally {
              try {
                span.end();
              } catch {
                // Diagnostics cannot change application truth.
              }
            }
          },
        );
      } catch {
        return work();
      }
    },
  });

  function record(
    outcome: WorkflowAuthoringOutcome,
    operation: WorkflowAuthoringOperation,
    startedAt: number,
    finishedAt: number,
    span: WorkflowAuthoringSpan,
  ): void {
    try {
      const attributes = { operation, outcome } as const;
      safeAttribute(span, 'outcome', outcome);
      operations.add(1, attributes);
      duration.record(Math.max(0, finishedAt - startedAt) / 1_000, attributes);
    } catch {
      // Diagnostics cannot change application truth.
    }
  }
}

function safeNow(clock: () => number): number {
  try {
    const value = clock();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function safeAttribute(
  span: WorkflowAuthoringSpan,
  name: 'operation' | 'outcome',
  value: WorkflowAuthoringOperation | WorkflowAuthoringOutcome,
): void {
  try {
    span.setAttribute(name, value);
  } catch {
    // Diagnostics cannot change application truth.
  }
}

export const NOOP_WORKFLOW_AUTHORING_TELEMETRY: WorkflowAuthoringTelemetry =
  Object.freeze({
    measure: <T>(
      _operation: WorkflowAuthoringOperation,
      work: () => Promise<T>,
    ): Promise<T> => work(),
  });
