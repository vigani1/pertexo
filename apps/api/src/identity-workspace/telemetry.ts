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
  const operations = options.meter.createCounter(
    IDENTITY_WORKSPACE_METRIC_NAME.operations,
    {
      description:
        'Completed identity and workspace operations by bounded operation and outcome',
      unit: '{operation}',
    },
  );
  const duration = options.meter.createHistogram(
    IDENTITY_WORKSPACE_METRIC_NAME.duration,
    {
      description:
        'Identity and workspace operation duration by bounded operation and outcome',
      unit: 's',
    },
  );
  const monotonicNow = options.monotonicNow ?? (() => performance.now());

  return Object.freeze({
    measure: <T>(
      operation: IdentityWorkspaceOperation,
      work: () => Promise<T>,
    ): Promise<T> =>
      options.tracer.startActiveSpan(
        `pertexo.identity_workspace.${operation}`,
        async (span): Promise<T> => {
          const startedAt = monotonicNow();
          span.setAttribute('operation', operation);
          try {
            const result = await work();
            record('succeeded', operation, startedAt, monotonicNow(), span);
            return result;
          } catch (error: unknown) {
            record('failed', operation, startedAt, monotonicNow(), span);
            throw error;
          } finally {
            span.end();
          }
        },
      ),
  });

  function record(
    outcome: IdentityWorkspaceOutcome,
    operation: IdentityWorkspaceOperation,
    startedAt: number,
    finishedAt: number,
    span: IdentityWorkspaceSpan,
  ): void {
    const attributes = { operation, outcome } as const;
    span.setAttribute('outcome', outcome);
    operations.add(1, attributes);
    duration.record(Math.max(0, finishedAt - startedAt) / 1_000, attributes);
  }
}

export const NOOP_IDENTITY_WORKSPACE_TELEMETRY: IdentityWorkspaceTelemetry =
  Object.freeze({
    measure: <T>(
      _operation: IdentityWorkspaceOperation,
      work: () => Promise<T>,
    ): Promise<T> => work(),
  });
