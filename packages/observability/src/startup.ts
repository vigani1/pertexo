// Loaded before anything else in a process: it must not import pino, pg,
// HTTP or the application, so OpenTelemetry can instrument them once started.
export {
  parseObservabilityConfig,
  type ObservabilityConfig,
  type ObservabilityConfigInput,
} from './config.js';
export {
  classifyProcessError,
  describeProcessFailure,
  type ProcessErrorType,
} from './process-failure/describe-process-failure.js';
export {
  createOpenTelemetrySdk,
  createTelemetryLifecycle,
  type TelemetryLifecycle,
  type TelemetrySdk,
  type TelemetrySdkFactory,
} from './telemetry/telemetry.runtime.js';
export {
  databaseClientEnvironmentSchema,
  clientDatabaseConfig,
} from './lifecycle/database-config.js';

export {
  KEY_RING_REPAIR_BOUNDS,
  StartupSettingError,
  parseStartupSettings,
} from './process-failure/startup-setting.errors.js';
