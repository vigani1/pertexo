import { describe, expect, it, vi } from 'vitest';
import {
  HTTP_REQUEST_EXECUTOR,
  SLACK_BOT_TOKEN_CONNECTION_SLOT,
  SLACK_SEND_MESSAGE_DEFINITION,
  SLACK_SEND_MESSAGE_EXECUTOR,
  EMAIL_SEND_NOTIFICATION_DEFINITION,
  EMAIL_SEND_NOTIFICATION_EXECUTOR,
  RESEND_API_KEY_CONNECTION_SLOT,
} from '@pertexo/integrations';
import {
  CORE_CONDITION_DEFINITION,
  CORE_CONDITION_EXECUTOR,
  CORE_MERGE_DEFINITION,
  CORE_MERGE_DEFINITION_V2,
  CORE_MERGE_DEFINITION_V3,
  CORE_MERGE_EXECUTOR,
  CORE_MERGE_EXECUTOR_V2,
  CORE_MERGE_EXECUTOR_V3,
  CORE_PARALLEL_DEFINITION,
  CORE_PARALLEL_DEFINITION_V2,
  CORE_PARALLEL_DEFINITION_V3,
  CORE_PARALLEL_EXECUTOR,
  CORE_PARALLEL_EXECUTOR_V2,
  CORE_PARALLEL_EXECUTOR_V3,
  CORE_SCHEDULE_CONFIG_SCHEMA,
  CORE_SCHEDULE_DEFINITION,
  CORE_SCHEDULE_DEFINITION_V2,
  CORE_SCHEDULE_DEFINITION_V3,
  CORE_SCHEDULE_EXECUTOR_V2,
  CORE_SCHEDULE_EXECUTOR_V3,
  CORE_SWITCH_DEFINITION,
  CORE_VALIDATE_DEFINITION,
  CORE_VALIDATE_EXECUTOR,
  CORE_WEBHOOK_DEFINITION,
} from '@pertexo/nodes-core';

import {
  PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
  PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED,
  PLATFORM_REGISTRY_RELEASE_HISTORY,
  PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_FOR_EACH_STAGED,
  PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_MERGE_STAGED,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED,
  PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED,
  PLATFORM_REGISTRY_RELEASE_WAIT_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_WAIT_STAGED,
  PLATFORM_REGISTRY_RELEASE_SLACK_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SLACK_STAGED,
  PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_EMAIL_STAGED,
  PLATFORM_EMAIL_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_EMAIL_STAGING_RELEASE_SUPPORT,
  PLATFORM_REGISTRY_RELEASE_SCHEDULE_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SCHEDULE_STAGED,
  PLATFORM_REGISTRY_RELEASE_SCHEDULE_V2_STAGED,
  PLATFORM_REGISTRY_RELEASE_SCHEDULE_V2_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_V2_STAGED,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_V2_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_MERGE_V2_STAGED,
  PLATFORM_REGISTRY_RELEASE_MERGE_V2_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SCHEDULE_V3_STAGED,
  PLATFORM_REGISTRY_RELEASE_SCHEDULE_V3_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_V3_STAGED,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_V3_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_MERGE_V3_STAGED,
  PLATFORM_REGISTRY_RELEASE_MERGE_V3_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_VALIDATE_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_VALIDATE_STAGED,
  PLATFORM_REGISTRY_RELEASE_WEBHOOK_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_WEBHOOK_STAGED,
  PLATFORM_SCHEDULE_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_SCHEDULE_STAGING_RELEASE_SUPPORT,
  PLATFORM_SCHEDULE_V2_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_SCHEDULE_V2_STAGING_RELEASE_SUPPORT,
  PLATFORM_PARALLEL_V2_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_PARALLEL_V2_STAGING_RELEASE_SUPPORT,
  PLATFORM_MERGE_V2_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_MERGE_V2_STAGING_RELEASE_SUPPORT,
  PLATFORM_SCHEDULE_V3_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_SCHEDULE_V3_STAGING_RELEASE_SUPPORT,
  PLATFORM_PARALLEL_V3_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_PARALLEL_V3_STAGING_RELEASE_SUPPORT,
  PLATFORM_MERGE_V3_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_MERGE_V3_STAGING_RELEASE_SUPPORT,
  PLATFORM_VALIDATE_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_VALIDATE_STAGING_RELEASE_SUPPORT,
  PLATFORM_WEBHOOK_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_WEBHOOK_STAGING_RELEASE_SUPPORT,
  PLATFORM_CONDITION_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_CONDITION_STAGING_RELEASE_SUPPORT,
  PLATFORM_FOR_EACH_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_FOR_EACH_STAGING_RELEASE_SUPPORT,
  PLATFORM_HTTP_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_HTTP_STAGING_RELEASE_SUPPORT,
  PLATFORM_MERGE_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_MERGE_STAGING_RELEASE_SUPPORT,
  PLATFORM_PARALLEL_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_PARALLEL_STAGING_RELEASE_SUPPORT,
  PLATFORM_SWITCH_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_SWITCH_STAGING_RELEASE_SUPPORT,
  PLATFORM_SLACK_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_SLACK_STAGING_RELEASE_SUPPORT,
  PLATFORM_REGISTRY_RELEASE_SUPPORT,
  PLATFORM_WAIT_ACTIVATION_RELEASE_SUPPORT,
  PLATFORM_WAIT_STAGING_RELEASE_SUPPORT,
  platformExecutableRegistryHistory,
  PLATFORM_RELEASE_COHORTS,
  platformRegistryReleaseSupport,
  platformServingReleaseRequiresHttpCapabilities,
  platformServingRegistryRelease,
  type PlatformReleaseCohort,
} from '../src/registry.js';
import {
  createPlatformNodeRegistryForRelease,
  resolvePlatformNodeDefinitionForRelease,
} from '../src/server.js';
import { PLATFORM_RELEASE_FINGERPRINT_GOLDEN } from './release-history.golden.js';

const PLATFORM_COHORT_EXPECTATIONS = [
  {
    cohort: 'core',
    support: PLATFORM_REGISTRY_RELEASE_SUPPORT,
    supportEpochs: [1, 2],
    servingEpoch: 2,
    requiresHttp: false,
    executableEpoch: 2,
  },
  {
    cohort: 'http_staging',
    support: PLATFORM_HTTP_STAGING_RELEASE_SUPPORT,
    supportEpochs: [2, 3],
    servingEpoch: 2,
    requiresHttp: false,
    executableEpoch: 3,
  },
  {
    cohort: 'http_activation',
    support: PLATFORM_HTTP_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [3, 4],
    servingEpoch: 4,
    requiresHttp: true,
    executableEpoch: 4,
  },
  {
    cohort: 'condition_staging',
    support: PLATFORM_CONDITION_STAGING_RELEASE_SUPPORT,
    supportEpochs: [4, 5],
    servingEpoch: 4,
    requiresHttp: true,
    executableEpoch: 5,
  },
  {
    cohort: 'condition_activation',
    support: PLATFORM_CONDITION_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [5, 6],
    servingEpoch: 6,
    requiresHttp: true,
    executableEpoch: 6,
  },
  {
    cohort: 'switch_staging',
    support: PLATFORM_SWITCH_STAGING_RELEASE_SUPPORT,
    supportEpochs: [6, 7],
    servingEpoch: 6,
    requiresHttp: true,
    executableEpoch: 7,
  },
  {
    cohort: 'switch_activation',
    support: PLATFORM_SWITCH_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [7, 8],
    servingEpoch: 8,
    requiresHttp: true,
    executableEpoch: 8,
  },
  {
    cohort: 'parallel_staging',
    support: PLATFORM_PARALLEL_STAGING_RELEASE_SUPPORT,
    supportEpochs: [8, 9],
    servingEpoch: 8,
    requiresHttp: true,
    executableEpoch: 9,
  },
  {
    cohort: 'parallel_activation',
    support: PLATFORM_PARALLEL_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [9, 10],
    servingEpoch: 10,
    requiresHttp: true,
    executableEpoch: 10,
  },
  {
    cohort: 'merge_staging',
    support: PLATFORM_MERGE_STAGING_RELEASE_SUPPORT,
    supportEpochs: [10, 11],
    servingEpoch: 10,
    requiresHttp: true,
    executableEpoch: 11,
  },
  {
    cohort: 'merge_activation',
    support: PLATFORM_MERGE_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [11, 12],
    servingEpoch: 12,
    requiresHttp: true,
    executableEpoch: 12,
  },
  {
    cohort: 'for_each_staging',
    support: PLATFORM_FOR_EACH_STAGING_RELEASE_SUPPORT,
    supportEpochs: [12, 13],
    servingEpoch: 12,
    requiresHttp: true,
    executableEpoch: 13,
  },
  {
    cohort: 'for_each_activation',
    support: PLATFORM_FOR_EACH_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [13, 14],
    servingEpoch: 14,
    requiresHttp: true,
    executableEpoch: 14,
  },
  {
    cohort: 'wait_staging',
    support: PLATFORM_WAIT_STAGING_RELEASE_SUPPORT,
    supportEpochs: [14, 15],
    servingEpoch: 14,
    requiresHttp: true,
    executableEpoch: 15,
  },
  {
    cohort: 'wait_activation',
    support: PLATFORM_WAIT_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [15, 16],
    servingEpoch: 16,
    requiresHttp: true,
    executableEpoch: 16,
  },
  {
    cohort: 'slack_staging',
    support: PLATFORM_SLACK_STAGING_RELEASE_SUPPORT,
    supportEpochs: [16, 17],
    servingEpoch: 16,
    requiresHttp: true,
    executableEpoch: 17,
  },
  {
    cohort: 'slack_activation',
    support: PLATFORM_SLACK_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [17, 18],
    servingEpoch: 18,
    requiresHttp: true,
    executableEpoch: 18,
  },
  {
    cohort: 'email_staging',
    support: PLATFORM_EMAIL_STAGING_RELEASE_SUPPORT,
    supportEpochs: [18, 19],
    servingEpoch: 18,
    requiresHttp: true,
    executableEpoch: 19,
  },
  {
    cohort: 'email_activation',
    support: PLATFORM_EMAIL_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [19, 20],
    servingEpoch: 20,
    requiresHttp: true,
    executableEpoch: 20,
  },
  {
    cohort: 'webhook_staging',
    support: PLATFORM_WEBHOOK_STAGING_RELEASE_SUPPORT,
    supportEpochs: [20, 21],
    servingEpoch: 20,
    requiresHttp: true,
    executableEpoch: 21,
  },
  {
    cohort: 'webhook_activation',
    support: PLATFORM_WEBHOOK_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [21, 22],
    servingEpoch: 22,
    requiresHttp: true,
    executableEpoch: 22,
  },
  {
    cohort: 'schedule_staging',
    support: PLATFORM_SCHEDULE_STAGING_RELEASE_SUPPORT,
    supportEpochs: [22, 23],
    servingEpoch: 22,
    requiresHttp: true,
    executableEpoch: 23,
  },
  {
    cohort: 'schedule_activation',
    support: PLATFORM_SCHEDULE_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [23, 24],
    servingEpoch: 24,
    requiresHttp: true,
    executableEpoch: 24,
  },
  {
    cohort: 'schedule_v2_staging',
    support: PLATFORM_SCHEDULE_V2_STAGING_RELEASE_SUPPORT,
    supportEpochs: [24, 25],
    servingEpoch: 24,
    requiresHttp: true,
    executableEpoch: 25,
  },
  {
    cohort: 'schedule_v2_activation',
    support: PLATFORM_SCHEDULE_V2_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [25, 26],
    servingEpoch: 26,
    requiresHttp: true,
    executableEpoch: 26,
  },
  {
    cohort: 'parallel_v2_staging',
    support: PLATFORM_PARALLEL_V2_STAGING_RELEASE_SUPPORT,
    supportEpochs: [26, 27],
    servingEpoch: 26,
    requiresHttp: true,
    executableEpoch: 27,
  },
  {
    cohort: 'parallel_v2_activation',
    support: PLATFORM_PARALLEL_V2_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [27, 28],
    servingEpoch: 28,
    requiresHttp: true,
    executableEpoch: 28,
  },
  {
    cohort: 'merge_v2_staging',
    support: PLATFORM_MERGE_V2_STAGING_RELEASE_SUPPORT,
    supportEpochs: [28, 29],
    servingEpoch: 28,
    requiresHttp: true,
    executableEpoch: 29,
  },
  {
    cohort: 'merge_v2_activation',
    support: PLATFORM_MERGE_V2_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [29, 30],
    servingEpoch: 30,
    requiresHttp: true,
    executableEpoch: 30,
  },
  {
    cohort: 'schedule_v3_staging',
    support: PLATFORM_SCHEDULE_V3_STAGING_RELEASE_SUPPORT,
    supportEpochs: [30, 31],
    servingEpoch: 30,
    requiresHttp: true,
    executableEpoch: 31,
  },
  {
    cohort: 'schedule_v3_activation',
    support: PLATFORM_SCHEDULE_V3_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [31, 32],
    servingEpoch: 32,
    requiresHttp: true,
    executableEpoch: 32,
  },
  {
    cohort: 'parallel_v3_staging',
    support: PLATFORM_PARALLEL_V3_STAGING_RELEASE_SUPPORT,
    supportEpochs: [32, 33],
    servingEpoch: 32,
    requiresHttp: true,
    executableEpoch: 33,
  },
  {
    cohort: 'parallel_v3_activation',
    support: PLATFORM_PARALLEL_V3_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [33, 34],
    servingEpoch: 34,
    requiresHttp: true,
    executableEpoch: 34,
  },
  {
    cohort: 'merge_v3_staging',
    support: PLATFORM_MERGE_V3_STAGING_RELEASE_SUPPORT,
    supportEpochs: [34, 35],
    servingEpoch: 34,
    requiresHttp: true,
    executableEpoch: 35,
  },
  {
    cohort: 'merge_v3_activation',
    support: PLATFORM_MERGE_V3_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [35, 36],
    servingEpoch: 36,
    requiresHttp: true,
    executableEpoch: 36,
  },
  {
    cohort: 'validate_staging',
    support: PLATFORM_VALIDATE_STAGING_RELEASE_SUPPORT,
    supportEpochs: [36, 37],
    servingEpoch: 36,
    requiresHttp: true,
    executableEpoch: 37,
  },
  {
    cohort: 'validate_activation',
    support: PLATFORM_VALIDATE_ACTIVATION_RELEASE_SUPPORT,
    supportEpochs: [37, 38],
    servingEpoch: 38,
    requiresHttp: true,
    executableEpoch: 38,
  },
] as const satisfies readonly {
  readonly cohort: PlatformReleaseCohort;
  readonly support: readonly unknown[];
  readonly supportEpochs: readonly [number, number];
  readonly servingEpoch: number;
  readonly requiresHttp: boolean;
  readonly executableEpoch: number;
}[];

const PLATFORM_LIFECYCLE_EXPECTATIONS = [
  {
    label: 'core.http.request@1',
    staged: PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    executor: HTTP_REQUEST_EXECUTOR,
    abiVersion: 2,
  },
  {
    label: 'core.condition@1',
    staged: PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
    executor: CORE_CONDITION_EXECUTOR,
    abiVersion: 1,
  },
  {
    label: 'core.switch@1',
    staged: PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
    executor: { key: 'core.switch', version: 1 },
    abiVersion: 1,
  },
  {
    label: 'core.parallel@1',
    staged: PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE,
    executor: CORE_PARALLEL_EXECUTOR,
    abiVersion: 1,
  },
  {
    label: 'core.merge@1',
    staged: PLATFORM_REGISTRY_RELEASE_MERGE_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
    executor: CORE_MERGE_EXECUTOR,
    abiVersion: 1,
  },
  {
    label: 'core.foreach@1',
    staged: PLATFORM_REGISTRY_RELEASE_FOR_EACH_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
    executor: { key: 'core.foreach', version: 1 },
    abiVersion: 1,
  },
  {
    label: 'core.wait@1',
    staged: PLATFORM_REGISTRY_RELEASE_WAIT_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_WAIT_ACTIVE,
    executor: { key: 'core.wait', version: 1 },
    abiVersion: 1,
  },
  {
    label: 'slack.send_message@1',
    staged: PLATFORM_REGISTRY_RELEASE_SLACK_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_SLACK_ACTIVE,
    executor: SLACK_SEND_MESSAGE_EXECUTOR,
    abiVersion: 2,
  },
  {
    label: 'email.send_notification@1',
    staged: PLATFORM_REGISTRY_RELEASE_EMAIL_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
    executor: EMAIL_SEND_NOTIFICATION_EXECUTOR,
    abiVersion: 2,
  },
  {
    label: 'core.webhook@1',
    staged: PLATFORM_REGISTRY_RELEASE_WEBHOOK_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_WEBHOOK_ACTIVE,
    executor: { key: 'core.webhook', version: 1 },
    abiVersion: 1,
  },
  {
    label: 'core.schedule@1',
    staged: PLATFORM_REGISTRY_RELEASE_SCHEDULE_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_SCHEDULE_ACTIVE,
    executor: { key: 'core.schedule', version: 1 },
    abiVersion: 1,
  },
  {
    label: 'core.schedule@2',
    staged: PLATFORM_REGISTRY_RELEASE_SCHEDULE_V2_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_SCHEDULE_V2_ACTIVE,
    executor: CORE_SCHEDULE_EXECUTOR_V2,
    abiVersion: 1,
  },
  {
    label: 'core.parallel@2',
    staged: PLATFORM_REGISTRY_RELEASE_PARALLEL_V2_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_PARALLEL_V2_ACTIVE,
    executor: CORE_PARALLEL_EXECUTOR_V2,
    abiVersion: 1,
  },
  {
    label: 'core.merge@2',
    staged: PLATFORM_REGISTRY_RELEASE_MERGE_V2_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_MERGE_V2_ACTIVE,
    executor: CORE_MERGE_EXECUTOR_V2,
    abiVersion: 1,
  },
  {
    label: 'core.schedule@3',
    staged: PLATFORM_REGISTRY_RELEASE_SCHEDULE_V3_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_SCHEDULE_V3_ACTIVE,
    executor: CORE_SCHEDULE_EXECUTOR_V3,
    abiVersion: 1,
  },
  {
    label: 'core.parallel@3',
    staged: PLATFORM_REGISTRY_RELEASE_PARALLEL_V3_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_PARALLEL_V3_ACTIVE,
    executor: CORE_PARALLEL_EXECUTOR_V3,
    abiVersion: 1,
  },
  {
    label: 'core.merge@3',
    staged: PLATFORM_REGISTRY_RELEASE_MERGE_V3_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_MERGE_V3_ACTIVE,
    executor: CORE_MERGE_EXECUTOR_V3,
    abiVersion: 1,
  },
  {
    label: 'core.validate@1',
    staged: PLATFORM_REGISTRY_RELEASE_VALIDATE_STAGED,
    active: PLATFORM_REGISTRY_RELEASE_VALIDATE_ACTIVE,
    executor: CORE_VALIDATE_EXECUTOR,
    abiVersion: 1,
  },
] as const;

describe('platform node release history and cohorts', () => {
  it('pins every retained compatibility identity independently of manifests', () => {
    expect(
      PLATFORM_REGISTRY_RELEASE_HISTORY.map(({ epoch, fingerprint }) => ({
        epoch,
        fingerprint,
      })),
    ).toEqual(
      PLATFORM_RELEASE_FINGERPRINT_GOLDEN.map((fingerprint, index) => ({
        epoch: index + 1,
        fingerprint,
      })),
    );
  });

  it('resolves the exact active generic Webhook release', () => {
    const definition = resolvePlatformNodeDefinitionForRelease(
      PLATFORM_REGISTRY_RELEASE_WEBHOOK_ACTIVE,
      CORE_WEBHOOK_DEFINITION,
    );
    expect(definition.manifest).toMatchObject({
      definition: { key: 'core.webhook', version: 1 },
      family: 'trigger',
      ports: { inputs: [], outputs: ['out'] },
      credentialRequirements: [],
      connectionRequirements: [],
    });
    expect(definition.configSchema.safeParse({}).success).toBe(true);
    expect(
      definition.configSchema.safeParse({ signingSecret: 'must-not-live-here' })
        .success,
    ).toBe(false);
  });

  it('resolves the exact active strict Schedule release', () => {
    const definition = resolvePlatformNodeDefinitionForRelease(
      PLATFORM_REGISTRY_RELEASE_SCHEDULE_ACTIVE,
      CORE_SCHEDULE_DEFINITION,
    );
    expect(definition.manifest).toMatchObject({
      definition: { key: 'core.schedule', version: 1 },
      family: 'trigger',
      ports: { inputs: [], outputs: ['out'] },
    });
    expect(
      definition.configSchema.safeParse({
        kind: 'cron',
        expression: '0 9 * * 1-5',
        timezone: 'America/New_York',
        misfirePolicy: 'catch_up_once',
      }).success,
    ).toBe(true);
    expect(
      CORE_SCHEDULE_CONFIG_SCHEMA.safeParse({
        kind: 'interval',
        intervalMinutes: 43_200,
        misfirePolicy: 'skip',
      }).success,
    ).toBe(true);
    expect(
      CORE_SCHEDULE_CONFIG_SCHEMA.parse({
        kind: 'interval',
        intervalMinutes: 15,
      }),
    ).toEqual({
      kind: 'interval',
      intervalMinutes: 15,
      misfirePolicy: 'catch_up_once',
    });
    for (const config of [
      {
        kind: 'cron',
        expression: '0 9 * * 1-5',
        misfirePolicy: 'catch_up_once',
      },
      {
        kind: 'cron',
        expression: '0 0 9 * * 1-5',
        timezone: 'America/New_York',
        misfirePolicy: 'catch_up_once',
      },
      {
        kind: 'cron',
        expression: '0 9 * * 1-5',
        timezone: 'US/Eastern',
        misfirePolicy: 'catch_up_once',
      },
      { kind: 'interval', intervalMinutes: 0, misfirePolicy: 'skip' },
      { kind: 'interval', intervalMinutes: 43_201, misfirePolicy: 'skip' },
      {
        kind: 'interval',
        intervalMinutes: 15,
        timezone: 'UTC',
        misfirePolicy: 'skip',
      },
      { kind: 'interval', intervalMinutes: 15, misfirePolicy: 'replay_all' },
    ])
      expect(CORE_SCHEDULE_CONFIG_SCHEMA.safeParse(config).success).toBe(false);
  });

  it('retains staged and active email releases with no staging admission', async () => {
    const sendNotification = vi.fn(
      async (input: { beforeDispatch(): Promise<void> }) => {
        await input.beforeDispatch();
        return {
          kind: 'succeeded' as const,
          emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
        };
      },
    );
    const secret = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        type: 'resend_api_key',
        apiKey: 're_123456789_secret',
        fromEmail: 'sender@example.com',
      }),
    );
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE,
      { emailSendNotification: { client: { sendNotification } } },
    );
    await expect(
      registry.execute({
        config: { timeoutMillis: 10_000 },
        definition: EMAIL_SEND_NOTIFICATION_DEFINITION,
        executor: EMAIL_SEND_NOTIFICATION_EXECUTOR,
        input: { toEmail: 'to@example.com', subject: 'Subject', text: 'Text' },
        connectionRefs: {
          [RESEND_API_KEY_CONNECTION_SLOT]:
            '22222222-2222-4222-8222-222222222222',
        },
        runtime: {
          workspaceId: '11111111-1111-4111-8111-111111111111',
          runId: '33333333-3333-4333-8333-333333333333',
          nodeRunId: '44444444-4444-4444-8444-444444444444',
          attemptId: '55555555-5555-4555-8555-555555555555',
          attemptNumber: 1,
          nodeId: 'email',
          invocationKey: 'email',
          sideEffectClass: 'idempotent_with_key',
          providerIdempotencyKey: 'stable-resend-key',
          beforeDispatch: () => Promise.resolve(),
          connections: {
            resolve: () =>
              Promise.resolve({
                connectionId: '22222222-2222-4222-8222-222222222222',
                providerKey: 'email',
                authType: 'resend_api_key',
                secretVersionId: '66666666-6666-4666-8666-666666666666',
                secret,
              }),
            assertCurrent: () => Promise.resolve(),
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2' },
    });
  });
  it('retains staged and active Slack releases with no staging admission', async () => {
    const sendMessage = vi.fn(
      async (input: { beforeDispatch(): Promise<void> }) => {
        await input.beforeDispatch();
        return {
          kind: 'succeeded' as const,
          channelId: 'C123ABC',
          messageTs: '1724412345.000100',
        };
      },
    );
    const secret = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        type: 'slack_bot_token',
        botToken: 'xoxb-123456789-secret',
      }),
    );
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_SLACK_ACTIVE,
      { slackSendMessage: { client: { sendMessage } } },
    );
    await expect(
      registry.execute({
        config: { timeoutMillis: 10_000 },
        definition: SLACK_SEND_MESSAGE_DEFINITION,
        executor: SLACK_SEND_MESSAGE_EXECUTOR,
        input: { channelId: 'C123ABC', text: 'deployed' },
        connectionRefs: {
          [SLACK_BOT_TOKEN_CONNECTION_SLOT]:
            '22222222-2222-4222-8222-222222222222',
        },
        runtime: {
          workspaceId: '11111111-1111-4111-8111-111111111111',
          runId: '33333333-3333-4333-8333-333333333333',
          nodeRunId: '44444444-4444-4444-8444-444444444444',
          attemptId: '55555555-5555-4555-8555-555555555555',
          attemptNumber: 1,
          nodeId: 'slack',
          invocationKey: 'slack',
          sideEffectClass: 'unsafe',
          beforeDispatch: () => Promise.resolve(),
          connections: {
            resolve: () =>
              Promise.resolve({
                connectionId: '22222222-2222-4222-8222-222222222222',
                providerKey: 'slack',
                authType: 'slack_bot_token',
                secretVersionId: '66666666-6666-4666-8666-666666666666',
                secret,
              }),
            assertCurrent: () => Promise.resolve(),
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { channelId: 'C123ABC', messageTs: '1724412345.000100' },
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(secret.every((byte) => byte === 0)).toBe(true);
  });

  it('executes a settled Merge ledger only in its additive release', async () => {
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
    );
    const input = {
      ledger: {
        'branch-01': { disposition: 'arrived' },
        'branch-02': { disposition: 'skipped' },
      },
      selectedBranchIds: ['branch-01'],
    };
    await expect(
      registry.execute({
        config: { parallelNodeId: 'parallel', policy: { kind: 'any' } },
        definition: CORE_MERGE_DEFINITION,
        executor: CORE_MERGE_EXECUTOR,
        input,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: input });
  });

  it('executes bounded Parallel declaration only in its additive release', async () => {
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE,
    );
    await expect(
      registry.execute({
        config: {
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          maxConcurrency: 1,
        },
        definition: CORE_PARALLEL_DEFINITION,
        executor: CORE_PARALLEL_EXECUTOR,
        input: {},
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { branchIds: ['branch-02', 'branch-01'] },
    });
  });

  it('rejects a non-additive Switch identity', () => {
    expect(() =>
      resolvePlatformNodeDefinitionForRelease(
        PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
        CORE_SWITCH_DEFINITION,
      ),
    ).toThrow(/not implemented/u);
  });

  it('resolves and executes Condition only in its exact additive release', async () => {
    const definition = resolvePlatformNodeDefinitionForRelease(
      PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
      CORE_CONDITION_DEFINITION,
    );
    expect(definition.manifest).toMatchObject({
      definition: { key: 'core.condition', version: 1 },
      executor: { key: 'core.condition', version: 1 },
      family: 'logic',
      ports: { inputs: ['in'], outputs: ['true', 'false'] },
      resourceClass: 'cpu',
      retryClass: 'safe',
    });
    expect(definition.configSchema.safeParse({}).success).toBe(true);
    expect(definition.configSchema.safeParse({ extra: true }).success).toBe(
      false,
    );
    expect(definition.inputSchema.safeParse({ condition: true }).success).toBe(
      true,
    );
    expect(definition.inputSchema.safeParse({ condition: 1 }).success).toBe(
      false,
    );

    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
    );
    await expect(
      registry.execute({
        config: {},
        definition: CORE_CONDITION_DEFINITION,
        executor: CORE_CONDITION_EXECUTOR,
        input: { condition: false },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { selectedPort: 'false' },
    });
    expect(() =>
      resolvePlatformNodeDefinitionForRelease(
        PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
        CORE_CONDITION_DEFINITION,
      ),
    ).toThrow(/not implemented/u);
  });

  it('retains every release cohort and staged/active lifecycle in canonical order', () => {
    expect(
      PLATFORM_COHORT_EXPECTATIONS.map(({ cohort }) => cohort),
      'platform release cohort expectation coverage',
    ).toEqual(PLATFORM_RELEASE_COHORTS);

    for (const expectation of PLATFORM_COHORT_EXPECTATIONS) {
      const context = `cohort ${expectation.cohort}`;
      expect(platformRegistryReleaseSupport(expectation.cohort), context).toBe(
        expectation.support,
      );
      expect(
        expectation.support.map(({ epoch }) => epoch),
        `${context} support epochs`,
      ).toEqual(expectation.supportEpochs);
      expect(
        platformServingRegistryRelease(expectation.cohort).epoch,
        `${context} serving epoch`,
      ).toBe(expectation.servingEpoch);
      expect(
        platformServingReleaseRequiresHttpCapabilities(expectation.cohort),
        `${context} HTTP capability requirement`,
      ).toBe(expectation.requiresHttp);
      expect(
        platformExecutableRegistryHistory(expectation.cohort).map(
          ({ epoch }) => epoch,
        ),
        `${context} executable epochs`,
      ).toEqual(
        Array.from(
          { length: expectation.executableEpoch },
          (_, index) => index + 1,
        ),
      );
    }
    for (const expectation of PLATFORM_LIFECYCLE_EXPECTATIONS) {
      const stagedExecutor = expectation.staged.executors.find(
        ({ executor: candidate }) =>
          candidate.key === expectation.executor.key &&
          candidate.version === expectation.executor.version,
      );
      const activeExecutor = expectation.active.executors.find(
        ({ executor: candidate }) =>
          candidate.key === expectation.executor.key &&
          candidate.version === expectation.executor.version,
      );
      expect(
        stagedExecutor,
        `${expectation.label} staged lifecycle`,
      ).toMatchObject({
        lifecycle: 'staged',
        abiVersion: expectation.abiVersion,
      });
      expect(
        activeExecutor,
        `${expectation.label} active lifecycle`,
      ).toMatchObject({
        lifecycle: 'active',
        abiVersion: expectation.abiVersion,
      });
    }
    expect(
      new Set(
        PLATFORM_REGISTRY_RELEASE_HISTORY.map(({ fingerprint }) => fingerprint),
      ).size,
    ).toBe(PLATFORM_REGISTRY_RELEASE_HISTORY.length);
  });

  it('executes additive core contract successors without changing retained versions', async () => {
    const signal = new AbortController().signal;
    const scheduleInput = {
      nodeId: 'schedule',
      scheduledAt: '2026-09-05T01:00:00.000Z',
      schemaVersion: 1,
      triggerId: '018f47a0-7b5c-7e2d-8c3f-12ad4e8b9c01',
    };
    await expect(
      createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_SCHEDULE_V2_ACTIVE,
      ).execute({
        config: { intervalMinutes: 5, kind: 'interval' },
        definition: CORE_SCHEDULE_DEFINITION_V2,
        executor: CORE_SCHEDULE_EXECUTOR_V2,
        input: scheduleInput,
        signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: scheduleInput });

    await expect(
      createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_PARALLEL_V2_ACTIVE,
      ).execute({
        config: {
          branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
          maxConcurrency: 2,
        },
        definition: CORE_PARALLEL_DEFINITION_V2,
        executor: CORE_PARALLEL_EXECUTOR_V2,
        input: {},
        signal,
      }),
    ).resolves.toMatchObject({
      kind: 'succeeded',
      output: { branchIds: ['branch-01', 'branch-02'] },
    });

    const mergeInput = {
      ledger: { 'branch-01': { disposition: 'arrived' as const } },
      selectedBranchIds: ['branch-01'],
    };
    await expect(
      createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_MERGE_V2_ACTIVE,
      ).execute({
        config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
        definition: CORE_MERGE_DEFINITION_V2,
        executor: CORE_MERGE_EXECUTOR_V2,
        input: mergeInput,
        signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: mergeInput });

    await expect(
      createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_SCHEDULE_V3_ACTIVE,
      ).execute({
        config: { intervalMinutes: 5, kind: 'interval' },
        definition: CORE_SCHEDULE_DEFINITION_V3,
        executor: CORE_SCHEDULE_EXECUTOR_V3,
        input: scheduleInput,
        signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: scheduleInput });

    await expect(
      createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_PARALLEL_V3_ACTIVE,
      ).execute({
        config: {
          branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
          maxConcurrency: 2,
        },
        definition: CORE_PARALLEL_DEFINITION_V3,
        executor: CORE_PARALLEL_EXECUTOR_V3,
        input: {},
        signal,
      }),
    ).resolves.toMatchObject({
      kind: 'succeeded',
      output: { branchIds: ['branch-01', 'branch-02'] },
    });

    await expect(
      createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_MERGE_V3_ACTIVE,
      ).execute({
        config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
        definition: CORE_MERGE_DEFINITION_V3,
        executor: CORE_MERGE_EXECUTOR_V3,
        input: mergeInput,
        signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: mergeInput });

    await expect(
      createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_VALIDATE_ACTIVE,
      ).execute({
        config: {
          rules: [
            { id: 'name', path: '$.name', required: true, type: 'string' },
            { id: 'count', path: '$.count', type: 'number', minimum: 2 },
          ],
        },
        definition: CORE_VALIDATE_DEFINITION,
        executor: CORE_VALIDATE_EXECUTOR,
        input: { name: 'catalog', count: 1 },
        signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: {
        valid: false,
        issues: [
          {
            ruleId: 'count',
            path: '$.count',
            code: 'minimum',
            message: 'Number is below the minimum.',
          },
        ],
        truncated: false,
      },
    });
  });
});
