import { metrics } from '@opentelemetry/api';
import type { Meter } from '@opentelemetry/api';

export const OBJECT_STORE_METRIC_NAME = Object.freeze({
  requestCount: 'pertexo.object_store.request.count',
  requestDuration: 'pertexo.object_store.request.duration',
  safetyViolationCount: 'pertexo.object_store.safety.violation.count',
});

export type ObjectStoreSurface = 'artifact' | 'control_ledger';
export type ObjectStoreRegionRole = 'artifact' | 'primary' | 'recovery';
export type ObjectStoreOperation =
  | 'delete_object'
  | 'delete_objects'
  | 'get_bucket_lifecycle_configuration'
  | 'get_bucket_location'
  | 'get_bucket_policy'
  | 'get_bucket_versioning'
  | 'get_object'
  | 'get_object_lock_configuration'
  | 'head_bucket'
  | 'head_object'
  | 'list_objects_v2'
  | 'list_object_versions'
  | 'presign_put_object'
  | 'put_object'
  | 'unknown';
export type ObjectStoreRequestOutcome = 'success' | 'error';
export type ObjectStoreErrorClass =
  | 'none'
  | 'aborted'
  | 'timeout'
  | 'not_found'
  | 'precondition_failed'
  | 'service_error'
  | 'unknown';
export type ObjectStoreSafetyCheck =
  | 'artifact_integrity'
  | 'control_ledger_integrity'
  | 'control_ledger_readiness'
  | 'region_isolation';

export interface ObjectStoreRequestObservation {
  readonly durationSeconds: number;
  readonly errorClass: ObjectStoreErrorClass;
  readonly operation: ObjectStoreOperation;
  readonly outcome: ObjectStoreRequestOutcome;
  readonly regionRole: ObjectStoreRegionRole;
  readonly surface: ObjectStoreSurface;
}

export interface ObjectStoreSafetyObservation {
  readonly check: ObjectStoreSafetyCheck;
  readonly regionRole: ObjectStoreRegionRole;
  readonly surface: ObjectStoreSurface;
}

export interface ObjectStoreObserver {
  observeRequest(observation: ObjectStoreRequestObservation): void;
  observeSafetyViolation(observation: ObjectStoreSafetyObservation): void;
}

export function createOpenTelemetryObjectStoreObserver(
  options: Readonly<{ meter?: Meter }> = {},
): ObjectStoreObserver {
  const meter =
    options.meter ?? metrics.getMeter('@pertexo/artifact-store', '0.0.0');
  const requestCount = meter.createCounter(
    OBJECT_STORE_METRIC_NAME.requestCount,
    {
      description: 'Object-store requests by bounded operation and outcome',
    },
  );
  const requestDuration = meter.createHistogram(
    OBJECT_STORE_METRIC_NAME.requestDuration,
    {
      description: 'Object-store request duration',
      unit: 's',
    },
  );
  const safetyViolationCount = meter.createCounter(
    OBJECT_STORE_METRIC_NAME.safetyViolationCount,
    { description: 'Object-store safety checks that failed closed' },
  );

  return Object.freeze({
    observeRequest(observation: ObjectStoreRequestObservation): void {
      const attributes = {
        error_class: observation.errorClass,
        operation: observation.operation,
        outcome: observation.outcome,
        region_role: observation.regionRole,
        surface: observation.surface,
      };
      requestCount.add(1, attributes);
      requestDuration.record(observation.durationSeconds, attributes);
    },
    observeSafetyViolation(observation: ObjectStoreSafetyObservation): void {
      safetyViolationCount.add(1, {
        check: observation.check,
        region_role: observation.regionRole,
        surface: observation.surface,
      });
    },
  });
}

let productionObserver: ObjectStoreObserver | undefined;

export function createProductionObjectStoreObserver(): ObjectStoreObserver {
  productionObserver ??= createOpenTelemetryObjectStoreObserver();
  return productionObserver;
}

export function safelyObserveRequest(
  observer: ObjectStoreObserver | undefined,
  observation: ObjectStoreRequestObservation,
): void {
  try {
    observer?.observeRequest(observation);
  } catch {
    // Telemetry must never affect object-store behavior.
  }
}

export function safelyObserveSafetyViolation(
  observer: ObjectStoreObserver | undefined,
  observation: ObjectStoreSafetyObservation,
): void {
  try {
    observer?.observeSafetyViolation(observation);
  } catch {
    // Telemetry must never affect safety enforcement.
  }
}

interface S3ClientShape {
  destroy(): void;
  send(
    command: never,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

const OPERATIONS: Readonly<Record<string, ObjectStoreOperation>> =
  Object.freeze({
    DeleteObjectCommand: 'delete_object',
    DeleteObjectsCommand: 'delete_objects',
    GetBucketLifecycleConfigurationCommand:
      'get_bucket_lifecycle_configuration',
    GetBucketLocationCommand: 'get_bucket_location',
    GetBucketPolicyCommand: 'get_bucket_policy',
    GetBucketVersioningCommand: 'get_bucket_versioning',
    GetObjectCommand: 'get_object',
    GetObjectLockConfigurationCommand: 'get_object_lock_configuration',
    HeadBucketCommand: 'head_bucket',
    HeadObjectCommand: 'head_object',
    ListObjectsV2Command: 'list_objects_v2',
    ListObjectVersionsCommand: 'list_object_versions',
    PutObjectCommand: 'put_object',
  });

function operationFor(command: object): ObjectStoreOperation {
  return OPERATIONS[command.constructor.name] ?? 'unknown';
}

function errorClass(
  error: unknown,
  signal?: AbortSignal,
): ObjectStoreErrorClass {
  if (signal?.aborted === true) {
    const reason: unknown = signal.reason;
    return reason instanceof Error && reason.name === 'TimeoutError'
      ? 'timeout'
      : 'aborted';
  }
  if (typeof error !== 'object' || error === null) return 'unknown';
  const candidate = error as {
    readonly $metadata?: { readonly httpStatusCode?: number };
    readonly name?: string;
  };
  if (candidate.name === 'AbortError') return 'aborted';
  if (candidate.name === 'TimeoutError') return 'timeout';
  if (
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.$metadata?.httpStatusCode === 404
  ) {
    return 'not_found';
  }
  if (
    candidate.name === 'PreconditionFailed' ||
    candidate.$metadata?.httpStatusCode === 412
  ) {
    return 'precondition_failed';
  }
  if (candidate.$metadata?.httpStatusCode !== undefined) return 'service_error';
  return 'unknown';
}

export class ObservedS3Client<TClient extends S3ClientShape> {
  public constructor(
    private readonly client: TClient,
    private readonly observer: ObjectStoreObserver | undefined,
    private readonly surface: ObjectStoreSurface,
    private readonly regionRole: ObjectStoreRegionRole,
  ) {}

  public destroy(): void {
    this.client.destroy();
  }

  public async send(
    command: object,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown> {
    const startedAt = performance.now();
    const operation = operationFor(command);
    try {
      const send = this.client.send.bind(this.client) as (
        command: object,
        options?: { readonly abortSignal?: AbortSignal },
      ) => Promise<unknown>;
      const result = await send(command, options);
      safelyObserveRequest(this.observer, {
        durationSeconds: (performance.now() - startedAt) / 1_000,
        errorClass: 'none',
        operation,
        outcome: 'success',
        regionRole: this.regionRole,
        surface: this.surface,
      });
      return result;
    } catch (error: unknown) {
      safelyObserveRequest(this.observer, {
        durationSeconds: (performance.now() - startedAt) / 1_000,
        errorClass: errorClass(error, options?.abortSignal),
        operation,
        outcome: 'error',
        regionRole: this.regionRole,
        surface: this.surface,
      });
      throw error;
    }
  }
}

export async function observePresign<T>(
  observer: ObjectStoreObserver | undefined,
  regionRole: ObjectStoreRegionRole,
  presign: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await presign();
    safelyObserveRequest(observer, {
      durationSeconds: (performance.now() - startedAt) / 1_000,
      errorClass: 'none',
      operation: 'presign_put_object',
      outcome: 'success',
      regionRole,
      surface: 'artifact',
    });
    return result;
  } catch (error: unknown) {
    safelyObserveRequest(observer, {
      durationSeconds: (performance.now() - startedAt) / 1_000,
      errorClass: errorClass(error),
      operation: 'presign_put_object',
      outcome: 'error',
      regionRole,
      surface: 'artifact',
    });
    throw error;
  }
}
