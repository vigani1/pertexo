import type { ApiCallbackRuntime } from '../webhooks/callback-runtime.module.js';
import type {
  DatabaseRuntime,
  WorkspaceDatabase,
} from '@pertexo/database/platform';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

import type {
  ApiConnectionRuntime,
  ApiConnectionRuntimeOverrides,
} from '../connections/runtime.module.js';
import type {
  ApiIdentityRuntime,
  ApiIdentityRuntimeOverrides,
} from '../identity/runtime.module.js';
import type {
  ApiWorkflowRuntime,
  ApiWorkflowRuntimeOverrides,
} from '../workflow/runtime.module.js';
import type { ApiWebhookRuntime } from '../webhooks/runtime.module.js';
import type { ApiScheduleRuntime } from '../schedules/runtime.module.js';
import type { ApiNotificationRuntime } from '../notifications/runtime.module.js';
import type { RateLimitConsumer } from '../rate-limit/interceptor.js';
import type {
  ApiArtifactRuntime,
  ApiArtifactRuntimeOverrides,
} from '../artifacts/runtime.module.js';

export /*
 * The feature runtimes an API process owns: which to create from
 * configuration, which a caller supplied, and how to release them when
 * startup fails.
 */

type ApiApplicationDependencyCore = Readonly<{
  database?: WorkspaceDatabase;
  databaseRuntime?: DatabaseRuntime;
  callbackRuntime?: ApiCallbackRuntime;
  webhookRuntime?: ApiWebhookRuntime;
  scheduleRuntime?: ApiScheduleRuntime;
  notificationRuntime?: ApiNotificationRuntime;
  rateLimitConsumer?: RateLimitConsumer;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
}>;

type IdentityRuntimeSource =
  | Readonly<{
      identityRuntime: ApiIdentityRuntime;
      identityOverrides?: never;
    }>
  | Readonly<{
      identityRuntime?: undefined;
      identityOverrides?: ApiIdentityRuntimeOverrides;
    }>;

type ConnectionRuntimeSource =
  | Readonly<{
      connectionRuntime: ApiConnectionRuntime;
      connectionOverrides?: never;
    }>
  | Readonly<{
      connectionRuntime?: undefined;
      connectionOverrides?: ApiConnectionRuntimeOverrides;
    }>;

type WorkflowRuntimeSource =
  | Readonly<{
      workflowRuntime: ApiWorkflowRuntime;
      workflowOverrides?: never;
    }>
  | Readonly<{
      workflowRuntime?: undefined;
      workflowOverrides?: ApiWorkflowRuntimeOverrides;
    }>;

type ArtifactRuntimeSource =
  | Readonly<{
      artifactRuntime: ApiArtifactRuntime;
      artifactOverrides?: never;
    }>
  | Readonly<{
      artifactRuntime?: undefined;
      artifactOverrides?: ApiArtifactRuntimeOverrides;
    }>;

export type ApiApplicationDependencies = ApiApplicationDependencyCore &
  IdentityRuntimeSource &
  ConnectionRuntimeSource &
  WorkflowRuntimeSource &
  ArtifactRuntimeSource;

export interface ApiRuntimeResources {
  callbackRuntime: ApiCallbackRuntime | undefined;
  artifactRuntime: ApiArtifactRuntime | undefined;
  connectionRuntime: ApiConnectionRuntime | undefined;
  databaseRuntime: DatabaseRuntime | undefined;
  identityRuntime: ApiIdentityRuntime | undefined;
  notificationRuntime: ApiNotificationRuntime | undefined;
  scheduleRuntime: ApiScheduleRuntime | undefined;
  webhookRuntime: ApiWebhookRuntime | undefined;
  workflowRuntime: ApiWorkflowRuntime | undefined;
}

export type ApiRuntimeSet = Readonly<ApiRuntimeResources>;
