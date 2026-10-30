import {
  measureOperation,
  NOOP_OPERATION_TELEMETRY,
  type OperationTelemetry,
} from '@pertexo/observability';
export const IDENTITY_WORKSPACE_OPERATION = Object.freeze({
  sessionLogout: 'session.logout',
  userProfileRead: 'user.profile_read',
  userProfileUpdate: 'user.profile_update',
  workspaceCreate: 'workspace.create',
  workspaceRename: 'workspace.rename',
  accessibleWorkspacesList: 'workspace.accessible_list',
  workspaceMembersList: 'workspace.members_list',
  workspaceMemberRoleChange: 'workspace.member_role_change',
  workspaceMemberRemoval: 'workspace.member_removal',
  workspaceMemberLeave: 'workspace.member_leave',
  workspaceMemberSuspend: 'workspace.member_suspend',
  workspaceMemberReactivate: 'workspace.member_reactivate',
  workspaceOwnershipTransfer: 'workspace.ownership_transfer',
  workspaceRequestDeletion: 'workspace.request_deletion',
  workspaceRestore: 'workspace.restore',
  workspaceReactivate: 'workspace.reactivate',
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

export type IdentityWorkspaceTelemetry =
  OperationTelemetry<IdentityWorkspaceOperation>;

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
  return Object.freeze({
    measure: <T>(
      operation: IdentityWorkspaceOperation,
      work: () => Promise<T>,
    ): Promise<T> =>
      measureOperation<T, IdentityWorkspaceSpan>({
        operation,
        work,
        monotonicNow: options.monotonicNow,
        trace: (run) =>
          options.tracer.startActiveSpan(
            `pertexo.identity_workspace.${operation}`,
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

export const NOOP_IDENTITY_WORKSPACE_TELEMETRY: IdentityWorkspaceTelemetry =
  NOOP_OPERATION_TELEMETRY;
