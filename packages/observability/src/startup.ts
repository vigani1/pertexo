// Loaded before anything else in a process: it must not import pino, pg,
// HTTP or the application, so OpenTelemetry can instrument them once started.
export {
  parseObservabilityConfig,
  type ObservabilityConfig,
  type ObservabilityConfigInput,
} from './config.js';
export {
  classifyProcessError,
  type ProcessErrorType,
} from './process-error-classification.js';
export {
  createOpenTelemetrySdk,
  createTelemetryLifecycle,
  type TelemetryLifecycle,
  type TelemetrySdk,
  type TelemetrySdkFactory,
} from './telemetry/index.js';
