import type { ApiCallbackRuntime } from '../webhooks/callback-runtime.module.js';
import type {
  DatabaseRuntime,
  WorkspaceDatabase,
} from '@pertexo/database/platform';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

import type { ApiConnectionRuntime } from '../connections/runtime.module.js';
import type { ApiIdentityRuntime } from '../identity/runtime.module.js';
import type { ApiWorkflowRuntime } from '../workflow/runtime.module.js';
import type { ApiWebhookRuntime } from '../webhooks/runtime.module.js';
import type { ApiScheduleRuntime } from '../schedules/runtime.module.js';
import type { ApiNotificationRuntime } from '../notifications/runtime.module.js';
import type { ApiRateLimit } from '../rate-limit/module.js';
import type { ApiArtifactRuntime } from '../artifacts/runtime.module.js';

export type ApiApplicationDependencies = Readonly<{
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
}>;

/**
 * Everything the application is assembled from: acquired from configuration
 * in production. A feature left out is unavailable.
 */
export type ApiRuntimeSet = Readonly<{
  database: WorkspaceDatabase;
  databaseRuntime?: DatabaseRuntime | undefined;
  rateLimit: ApiRateLimit;
  callbackRuntime?: ApiCallbackRuntime | undefined;
  artifactRuntime?: ApiArtifactRuntime | undefined;
  connectionRuntime?: ApiConnectionRuntime | undefined;
  identityRuntime?: ApiIdentityRuntime | undefined;
  notificationRuntime?: ApiNotificationRuntime | undefined;
  scheduleRuntime?: ApiScheduleRuntime | undefined;
  webhookRuntime?: ApiWebhookRuntime | undefined;
  workflowRuntime?: ApiWorkflowRuntime | undefined;
}>;
