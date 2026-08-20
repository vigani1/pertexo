export const IDENTITY_WORKSPACE_OPERATION = Object.freeze({
  oidcStart: 'oidc.start',
  oidcCallback: 'oidc.callback',
  sessionLogout: 'session.logout',
  workspaceCreate: 'workspace.create',
  workspaceRequestDeletion: 'workspace.request_deletion',
  workspaceRestore: 'workspace.restore',
} as const);

export const IDENTITY_WORKSPACE_METRIC_NAME = Object.freeze({
  duration: 'pertexo.identity_workspace.operation.duration',
  operations: 'pertexo.identity_workspace.operation.count',
} as const);

export type IdentityWorkspaceOperation =
  (typeof IDENTITY_WORKSPACE_OPERATION)[keyof typeof IDENTITY_WORKSPACE_OPERATION];

export type IdentityWorkspaceOutcome = 'failed' | 'succeeded';

export type IdentityWorkspaceMetricAttributes = Readonly<{
  operation: IdentityWorkspaceOperation;
  outcome: IdentityWorkspaceOutcome;
}>;

export interface IdentityWorkspaceCounter {
  add(value: number, attributes: IdentityWorkspaceMetricAttributes): void;
}

export interface IdentityWorkspaceHistogram {
  record(value: number, attributes: IdentityWorkspaceMetricAttributes): void;
}

export interface IdentityWorkspaceMeter {
  createCounter(
    name: (typeof IDENTITY_WORKSPACE_METRIC_NAME)['operations'],
    options: Readonly<{ description: string; unit: '{operation}' }>,
  ): IdentityWorkspaceCounter;
  createHistogram(
    name: (typeof IDENTITY_WORKSPACE_METRIC_NAME)['duration'],
    options: Readonly<{ description: string; unit: 's' }>,
  ): IdentityWorkspaceHistogram;
}

export interface IdentityWorkspaceSpan {
  end(): void;
  setAttribute(
    name: 'operation' | 'outcome',
    value: IdentityWorkspaceOperation | IdentityWorkspaceOutcome,
  ): void;
}

export interface IdentityWorkspaceTracer {
  startActiveSpan<T>(
    name: `pertexo.identity_workspace.${IdentityWorkspaceOperation}`,
    callback: (span: IdentityWorkspaceSpan) => Promise<T>,
  ): Promise<T>;
}

export interface IdentityWorkspaceTelemetry {
  measure<T>(
    operation: IdentityWorkspaceOperation,
    work: () => Promise<T>,
  ): Promise<T>;
}

export type IdentityWorkspaceTelemetryOptions = Readonly<{
  meter: IdentityWorkspaceMeter;
  tracer: IdentityWorkspaceTracer;
  monotonicNow?: () => number;
}>;

export function createIdentityWorkspaceTelemetry(
  options: IdentityWorkspaceTelemetryOptions,
): IdentityWorkspaceTelemetry {
  let operations: IdentityWorkspaceCounter;
  let duration: IdentityWorkspaceHistogram;
  try {
    operations = options.meter.createCounter(
      IDENTITY_WORKSPACE_METRIC_NAME.operations,
      {
        description:
          'Completed identity and workspace operations by bounded operation and outcome',
        unit: '{operation}',
      },
    );
    duration = options.meter.createHistogram(
      IDENTITY_WORKSPACE_METRIC_NAME.duration,
      {
        description:
          'Identity and workspace operation duration by bounded operation and outcome',
        unit: 's',
      },
    );
  } catch {
    return NOOP_IDENTITY_WORKSPACE_TELEMETRY;
  }
  const monotonicNow = options.monotonicNow ?? (() => performance.now());

  return Object.freeze({
    measure: <T>(
      operation: IdentityWorkspaceOperation,
      work: () => Promise<T>,
    ): Promise<T> => {
      try {
        return options.tracer.startActiveSpan(
          `pertexo.identity_workspace.${operation}`,
          async (span): Promise<T> => {
            const startedAt = safeNow(monotonicNow);
            safeSpanAttribute(span, 'operation', operation);
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
                // Telemetry is diagnostic and cannot change command truth.
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
    outcome: IdentityWorkspaceOutcome,
    operation: IdentityWorkspaceOperation,
    startedAt: number,
    finishedAt: number,
    span: IdentityWorkspaceSpan,
  ): void {
    try {
      const attributes = { operation, outcome } as const;
      safeSpanAttribute(span, 'outcome', outcome);
      operations.add(1, attributes);
      duration.record(Math.max(0, finishedAt - startedAt) / 1_000, attributes);
    } catch {
      // Telemetry is diagnostic and cannot change command truth.
    }
  }
}

function safeNow(monotonicNow: () => number): number {
  try {
    const value = monotonicNow();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function safeSpanAttribute(
  span: IdentityWorkspaceSpan,
  name: 'operation' | 'outcome',
  value: IdentityWorkspaceOperation | IdentityWorkspaceOutcome,
): void {
  try {
    span.setAttribute(name, value);
  } catch {
    // Telemetry is diagnostic and cannot change command truth.
  }
}

export const NOOP_IDENTITY_WORKSPACE_TELEMETRY: IdentityWorkspaceTelemetry =
  Object.freeze({
    measure: <T>(
      _operation: IdentityWorkspaceOperation,
      work: () => Promise<T>,
    ): Promise<T> => work(),
  });
