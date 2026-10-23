import { expect, it } from 'vitest';

import { parseWorkerConfig } from '../../../src/config/worker.js';
import {
  databaseEnvironment,
  requiredEnvironment,
  callbackEnvironment,
} from './fixture.js';

export function registerReachesDeployedKMSProtocolPolicyAfter(): void {
  it('reaches the deployed KMS protocol policy after valid production telemetry parsing', () => {
    let thrown: unknown;
    try {
      parseWorkerConfig({
        ...requiredEnvironment,
        CONNECTION_KMS_ENDPOINT: 'http://kms.example.test',
        CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo-connections',
        CONNECTION_KMS_REGION: 'eu-central-1',
        ...callbackEnvironment,
        NODE_ENV: 'production',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.example.test/v1',
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toEqual(
      new Error('HTTPS connection KMS endpoint is required when deployed'),
    );
  });

  it('accepts HTTPS artifact storage and runs retention when deployed', () => {
    const selected = parseWorkerConfig({
      ...requiredEnvironment,
      ARTIFACT_STORE_ACCESS_KEY_ID: 'primary-access',
      ARTIFACT_STORE_BUCKET: 'primary-artifacts',
      ARTIFACT_STORE_ENDPOINT: 'https://artifacts.example.test',
      ARTIFACT_STORE_REGION: 'eu-central-1',
      ARTIFACT_STORE_SECRET_ACCESS_KEY: 'primary-secret',
      CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo-connections',
      CONNECTION_KMS_REGION: 'eu-central-1',
      ...callbackEnvironment,
      NODE_ENV: 'production',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.example.test/v1',
      AUTH_MAIL_EMAIL_API_KEY: 'provider-key',
      AUTH_MAIL_KEY: Buffer.alloc(32, 4).toString('base64'),
      AUTH_MAIL_KEY_VERSION: 'mail-v1',
      AUTH_MAIL_FROM: 'security@example.test',
      PUBLIC_WEB_ORIGIN: 'https://app.example.test',
    });

    expect(selected.artifactStore.endpoint).toBe(
      'https://artifacts.example.test',
    );
    expect(selected.retention.maintenanceDatabase).toBeDefined();
  });

  it('rejects a partially configured artifact store', () => {
    expect(() =>
      parseWorkerConfig({
        ...databaseEnvironment,
        ARTIFACT_STORE_ACCESS_KEY_ID: 'primary-access',
        ARTIFACT_STORE_BUCKET: 'primary-artifacts',
        ARTIFACT_STORE_ENDPOINT: 'http://localhost:9090',
        ARTIFACT_STORE_SECRET_ACCESS_KEY: 'primary-secret',
      }),
    ).toThrow('Invalid worker configuration');
  });

  it('runs retention through the maintenance database', () => {
    expect(
      parseWorkerConfig(requiredEnvironment).retention.maintenanceDatabase,
    ).toMatchObject({
      connectionString: requiredEnvironment.DATABASE_MAINTENANCE_URL,
      max: 2,
    });
  });

  it('normalizes supported scalar environment values before nested parsing', () => {
    const selected = parseWorkerConfig({
      ...requiredEnvironment,
      ARTIFACT_MAX_BYTES: 2_048,
      ARTIFACT_STORE_ACCESS_KEY_ID: 'primary-access',
      ARTIFACT_STORE_BUCKET: 'primary-artifacts',
      ARTIFACT_STORE_ENDPOINT: 'http://localhost:9090',
      ARTIFACT_STORE_FORCE_PATH_STYLE: true,
      ARTIFACT_STORE_REGION: 'us-east-1',
      ARTIFACT_STORE_SECRET_ACCESS_KEY: 'primary-secret',
      DATABASE_POOL_MAX: 7,
      WORKER_RESOURCE_UNHEALTHY_SAMPLES: 4,
    });

    expect(selected.database.max).toBe(7);
    expect(selected.resourceSafety.unhealthySamplesBeforeDrain).toBe(4);
    expect(selected.artifactStore.forcePathStyle).toBe(true);
    expect(selected.artifactStore.maxObjectBytes).toBe(2_048);
  });

  it('rejects non-scalar environment values before capability parsing', () => {
    let thrown: unknown;
    try {
      parseWorkerConfig({
        ...requiredEnvironment,
        CONNECTION_KMS_KEY_REFERENCE: ['alias/not-scalar'],
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toEqual(
      new TypeError('Worker environment values must be scalar'),
    );
  });

  it.each(['0', '65', '1.5'])(
    'rejects an invalid coordinator admission bound (%s)',
    (maximumAdmissions) => {
      expect(() =>
        parseWorkerConfig({
          ...requiredEnvironment,
          WORKFLOW_COORDINATOR_MAX_ADMISSIONS: maximumAdmissions,
        }),
      ).toThrow(/invalid worker configuration/i);
    },
  );

  it('tunes the auto-pause fold loop', () => {
    expect(
      parseWorkerConfig({
        ...requiredEnvironment,
        WORKFLOW_AUTO_PAUSE_FOLD_BATCH_SIZE: '250',
        WORKFLOW_AUTO_PAUSE_FOLD_POLL_MILLIS: '2000',
      }).workflowAutoPause,
    ).toEqual({ foldBatchSize: 250, foldPollMillis: 2_000 });
  });

  it.each([
    ['WORKFLOW_AUTO_PAUSE_FOLD_BATCH_SIZE', '0'],
    ['WORKFLOW_AUTO_PAUSE_FOLD_POLL_MILLIS', '99'],
  ])('rejects an invalid auto-pause setting (%s=%s)', (name, value) => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        [name]: value,
      }),
    ).toThrow(/invalid worker configuration/i);
  });

  it('tunes the workspace inbox fold loop', () => {
    const config = parseWorkerConfig({
      ...requiredEnvironment,
      WORKSPACE_INBOX_FOLD_BATCH_SIZE: '1000',
      WORKSPACE_INBOX_FOLD_POLL_MILLIS: '250',
    });

    expect(config.workspaceInbox).toEqual({
      foldBatchSize: 1_000,
      foldPollMillis: 250,
    });
  });

  it.each([
    ['WORKSPACE_INBOX_FOLD_BATCH_SIZE', '0'],
    ['WORKSPACE_INBOX_FOLD_BATCH_SIZE', '1001'],
    ['WORKSPACE_INBOX_FOLD_POLL_MILLIS', '99'],
  ])('rejects an invalid workspace inbox setting (%s=%s)', (name, value) => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        [name]: value,
      }),
    ).toThrow(/invalid worker configuration/i);
  });

  it.each([
    ['WORKFLOW_DUE_WAKEUP_BATCH_SIZE', '0'],
    ['WORKFLOW_DUE_WAKEUP_BATCH_SIZE', '101'],
    ['WORKFLOW_DUE_WAKEUP_POLL_MILLIS', '9'],
    ['WORKFLOW_DUE_WAKEUP_POLL_MILLIS', '60001'],
  ])('rejects an invalid due-wakeup scanner bound (%s=%s)', (name, value) => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        [name]: value,
      }),
    ).toThrow(/invalid worker configuration/i);
  });

  it.each([
    ['TRIGGER_SCHEDULE_BATCH_SIZE', '0'],
    ['TRIGGER_SCHEDULE_BATCH_SIZE', '101'],
    ['TRIGGER_SCHEDULE_LEASE_SECONDS', '0'],
    ['TRIGGER_SCHEDULE_LEASE_SECONDS', '301'],
    ['TRIGGER_SCHEDULE_POLL_MILLIS', '9'],
    ['TRIGGER_SCHEDULE_POLL_MILLIS', '60001'],
    ['TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS', '59'],
    ['TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS', '3601'],
    ['TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS', '300.5'],
    ['TRIGGER_SCHEDULE_ON_TIME_WINDOW_SECONDS', 'five minutes'],
  ])('rejects an invalid trigger scanner bound (%s=%s)', (name, value) => {
    expect(() =>
      parseWorkerConfig({
        ...requiredEnvironment,
        [name]: value,
      }),
    ).toThrow(/invalid worker configuration/i);
  });
}
