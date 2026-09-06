import { describe, expect, it, vi } from 'vitest';
import {
  HTTP_REQUEST_DEFINITION,
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
  CORE_FOR_EACH_DEFINITION,
  CORE_FOR_EACH_EXECUTOR,
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
  CORE_SET_DEFINITION,
  CORE_SCHEDULE_CONFIG_SCHEMA,
  CORE_SCHEDULE_DEFINITION,
  CORE_SCHEDULE_DEFINITION_V2,
  CORE_SCHEDULE_DEFINITION_V3,
  CORE_SCHEDULE_EXECUTOR,
  CORE_SCHEDULE_EXECUTOR_V2,
  CORE_SCHEDULE_EXECUTOR_V3,
  CORE_SWITCH_DEFINITION,
  CORE_SWITCH_EXECUTOR,
  CORE_VALIDATE_DEFINITION,
  CORE_VALIDATE_EXECUTOR,
  CORE_WAIT_DEFINITION,
  CORE_WAIT_EXECUTOR,
  CORE_WEBHOOK_DEFINITION,
  CORE_WEBHOOK_EXECUTOR,
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
  PLATFORM_REGISTRY_RELEASE_SCHEDULE_V2_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_V2_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_MERGE_V2_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SCHEDULE_V3_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_V3_ACTIVE,
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
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  platformServingReleaseRequiresHttpCapabilities,
  platformServingRegistryRelease,
} from '../src/registry.js';
import {
  createPlatformNodeRegistryForRelease,
  resolvePlatformNodeDefinitionForRelease,
} from '../src/server.js';
import { PLATFORM_RELEASE_FINGERPRINT_GOLDEN } from './release-history.golden.js';

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

  it('retains and executes staged-then-active generic Webhook releases', async () => {
    expect(PLATFORM_REGISTRY_RELEASE_WEBHOOK_STAGED.epoch).toBe(21);
    expect(PLATFORM_REGISTRY_RELEASE_WEBHOOK_ACTIVE.epoch).toBe(22);
    expect(
      PLATFORM_WEBHOOK_STAGING_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([20, 21]);
    expect(
      PLATFORM_WEBHOOK_ACTIVATION_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([21, 22]);
    expect(platformServingRegistryRelease('webhook_staging').epoch).toBe(20);
    expect(platformServingRegistryRelease('webhook_activation').epoch).toBe(22);

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
    await expect(
      createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_WEBHOOK_ACTIVE,
      ).execute({
        config: {},
        definition: CORE_WEBHOOK_DEFINITION,
        executor: CORE_WEBHOOK_EXECUTOR,
        input: { event: 'created', id: 42 },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { event: 'created', id: 42 },
    });
  });

  it('retains and executes strict staged-then-active Schedule releases', async () => {
    expect(PLATFORM_REGISTRY_RELEASE_SCHEDULE_STAGED.epoch).toBe(23);
    expect(PLATFORM_REGISTRY_RELEASE_SCHEDULE_ACTIVE.epoch).toBe(24);
    expect(
      PLATFORM_SCHEDULE_STAGING_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([22, 23]);
    expect(
      PLATFORM_SCHEDULE_ACTIVATION_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([23, 24]);
    expect(platformServingRegistryRelease('schedule_staging').epoch).toBe(22);
    expect(platformServingRegistryRelease('schedule_activation').epoch).toBe(
      24,
    );

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

    const input = { scheduledAt: '2026-08-25T13:00:00.000Z' };
    await expect(
      createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_SCHEDULE_ACTIVE,
      ).execute({
        config: {
          kind: 'interval',
          intervalMinutes: 15,
          misfirePolicy: 'skip',
        },
        definition: CORE_SCHEDULE_DEFINITION,
        executor: CORE_SCHEDULE_EXECUTOR,
        input,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: input });
  });

  it('retains staged and active email releases with no staging admission', async () => {
    expect(PLATFORM_REGISTRY_RELEASE_EMAIL_STAGED.epoch).toBe(19);
    expect(PLATFORM_REGISTRY_RELEASE_EMAIL_ACTIVE.epoch).toBe(20);
    expect(
      PLATFORM_EMAIL_STAGING_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([18, 19]);
    expect(
      PLATFORM_EMAIL_ACTIVATION_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([19, 20]);
    expect(platformServingRegistryRelease('email_staging').epoch).toBe(18);
    expect(platformServingRegistryRelease('email_activation').epoch).toBe(20);
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
    expect(PLATFORM_REGISTRY_RELEASE_SLACK_STAGED.epoch).toBe(17);
    expect(PLATFORM_REGISTRY_RELEASE_SLACK_ACTIVE.epoch).toBe(18);
    expect(
      PLATFORM_SLACK_STAGING_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([16, 17]);
    expect(
      PLATFORM_SLACK_ACTIVATION_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([17, 18]);
    expect(platformServingRegistryRelease('slack_staging').epoch).toBe(16);
    expect(platformServingRegistryRelease('slack_activation').epoch).toBe(18);
    expect(
      PLATFORM_REGISTRY_RELEASE_SLACK_STAGED.executors.find(
        ({ executor }) => executor.key === SLACK_SEND_MESSAGE_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'staged', abiVersion: 2 });
    expect(
      PLATFORM_REGISTRY_RELEASE_SLACK_ACTIVE.executors.find(
        ({ executor }) => executor.key === SLACK_SEND_MESSAGE_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'active', abiVersion: 2 });

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

  it('retains staged and active Wait releases with no staging admission', async () => {
    expect(PLATFORM_REGISTRY_RELEASE_WAIT_STAGED.epoch).toBe(15);
    expect(PLATFORM_REGISTRY_RELEASE_WAIT_ACTIVE.epoch).toBe(16);
    expect(platformServingRegistryRelease('wait_staging').epoch).toBe(14);
    await expect(
      createPlatformNodeRegistryForRelease(
        PLATFORM_REGISTRY_RELEASE_WAIT_ACTIVE,
      ).execute({
        config: { durationSeconds: 2_592_000 },
        definition: CORE_WAIT_DEFINITION,
        executor: CORE_WAIT_EXECUTOR,
        input: { preserved: true },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'succeeded', output: { preserved: true } });
  });
  it('executes bounded For Each declaration only in its additive release', async () => {
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
    );
    const items = [{ id: 'first' }, null, 3];
    await expect(
      registry.execute({
        config: {},
        definition: CORE_FOR_EACH_DEFINITION,
        executor: CORE_FOR_EACH_EXECUTOR,
        input: { items },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { items, iterationCount: 3 },
    });
    expect(PLATFORM_REGISTRY_RELEASE_FOR_EACH_STAGED.epoch).toBe(13);
    expect(PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE.epoch).toBe(14);
    expect(
      platformRegistryReleaseSupport('merge_activation').map(
        ({ epoch }) => epoch,
      ),
    ).toEqual([11, 12]);
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

  it('executes ordered Switch cases only in its exact additive release', async () => {
    const registry = createPlatformNodeRegistryForRelease(
      PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
    );
    const config = {
      cases: [
        { id: 'case-02', equals: 'same' },
        { id: 'case-01', equals: 'same' },
      ],
    };
    await expect(
      registry.execute({
        config,
        definition: CORE_SWITCH_DEFINITION,
        executor: CORE_SWITCH_EXECUTOR,
        input: { value: 'same' },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { selectedPort: 'case-02' },
    });
    await expect(
      registry.execute({
        config,
        definition: CORE_SWITCH_DEFINITION,
        executor: CORE_SWITCH_EXECUTOR,
        input: { value: 'missing' },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { selectedPort: 'default' },
    });
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
        input: { condition: true },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: 'succeeded',
      output: { selectedPort: 'true' },
    });
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

  it('retains every additive release in canonical order', () => {
    expect(PLATFORM_REGISTRY_RELEASE_HISTORY.map(({ epoch }) => epoch)).toEqual(
      [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
        21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38,
      ],
    );
    expect(PLATFORM_REGISTRY_RELEASE_SUPPORT.map(({ epoch }) => epoch)).toEqual(
      [1, 2],
    );
    expect(
      PLATFORM_HTTP_STAGING_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([2, 3]);
    expect(
      PLATFORM_HTTP_ACTIVATION_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([3, 4]);
    expect(
      PLATFORM_CONDITION_STAGING_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([4, 5]);
    expect(
      PLATFORM_CONDITION_ACTIVATION_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([5, 6]);
    expect(
      PLATFORM_SWITCH_STAGING_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([6, 7]);
    expect(
      PLATFORM_SWITCH_ACTIVATION_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([7, 8]);
    expect(
      PLATFORM_PARALLEL_STAGING_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([8, 9]);
    expect(
      PLATFORM_PARALLEL_ACTIVATION_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([9, 10]);
    expect(
      PLATFORM_MERGE_STAGING_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([10, 11]);
    expect(
      PLATFORM_MERGE_ACTIVATION_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([11, 12]);
    expect(
      PLATFORM_FOR_EACH_STAGING_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([12, 13]);
    expect(
      PLATFORM_FOR_EACH_ACTIVATION_RELEASE_SUPPORT.map(({ epoch }) => epoch),
    ).toEqual([13, 14]);
    expect(platformRegistryReleaseSupport('core')).toBe(
      PLATFORM_REGISTRY_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('http_staging')).toBe(
      PLATFORM_HTTP_STAGING_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('http_activation')).toBe(
      PLATFORM_HTTP_ACTIVATION_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('condition_staging')).toBe(
      PLATFORM_CONDITION_STAGING_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('condition_activation')).toBe(
      PLATFORM_CONDITION_ACTIVATION_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('switch_staging')).toBe(
      PLATFORM_SWITCH_STAGING_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('switch_activation')).toBe(
      PLATFORM_SWITCH_ACTIVATION_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('parallel_staging')).toBe(
      PLATFORM_PARALLEL_STAGING_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('parallel_activation')).toBe(
      PLATFORM_PARALLEL_ACTIVATION_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('merge_staging')).toBe(
      PLATFORM_MERGE_STAGING_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('merge_activation')).toBe(
      PLATFORM_MERGE_ACTIVATION_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('for_each_staging')).toBe(
      PLATFORM_FOR_EACH_STAGING_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('for_each_activation')).toBe(
      PLATFORM_FOR_EACH_ACTIVATION_RELEASE_SUPPORT,
    );
    expect(platformServingRegistryRelease('http_staging').epoch).toBe(2);
    expect(platformServingRegistryRelease('http_activation').epoch).toBe(4);
    expect(platformServingRegistryRelease('condition_staging').epoch).toBe(4);
    expect(platformServingRegistryRelease('condition_activation').epoch).toBe(
      6,
    );
    expect(platformServingRegistryRelease('switch_staging').epoch).toBe(6);
    expect(platformServingRegistryRelease('switch_activation').epoch).toBe(8);
    expect(platformServingRegistryRelease('parallel_staging').epoch).toBe(8);
    expect(platformServingRegistryRelease('parallel_activation').epoch).toBe(
      10,
    );
    expect(platformServingRegistryRelease('merge_staging').epoch).toBe(10);
    expect(platformServingRegistryRelease('merge_activation').epoch).toBe(12);
    expect(platformServingRegistryRelease('for_each_staging').epoch).toBe(12);
    expect(platformServingRegistryRelease('for_each_activation').epoch).toBe(
      14,
    );
    expect(platformServingReleaseRequiresHttpCapabilities('core')).toBe(false);
    expect(
      platformServingReleaseRequiresHttpCapabilities('condition_staging'),
    ).toBe(true);
    expect(
      platformServingReleaseRequiresHttpCapabilities('condition_activation'),
    ).toBe(true);
    expect(
      platformServingReleaseRequiresHttpCapabilities('switch_activation'),
    ).toBe(true);
    expect(
      platformExecutableRegistryHistory('http_staging').map(
        ({ epoch }) => epoch,
      ),
    ).toEqual([1, 2, 3]);
    expect(
      platformExecutableRegistryHistory('http_activation').map(
        ({ epoch }) => epoch,
      ),
    ).toEqual([1, 2, 3, 4]);
    expect(
      platformExecutableRegistryHistory('condition_activation').map(
        ({ epoch }) => epoch,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      platformExecutableRegistryHistory('switch_activation').map(
        ({ epoch }) => epoch,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      platformExecutableRegistryHistory('merge_activation').map(
        ({ epoch }) => epoch,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(
      platformExecutableRegistryHistory('for_each_activation').map(
        ({ epoch }) => epoch,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(platformRegistryReleaseSupport('validate_staging')).toBe(
      PLATFORM_VALIDATE_STAGING_RELEASE_SUPPORT,
    );
    expect(platformRegistryReleaseSupport('validate_activation')).toBe(
      PLATFORM_VALIDATE_ACTIVATION_RELEASE_SUPPORT,
    );
    expect(platformServingRegistryRelease('validate_staging').epoch).toBe(36);
    expect(platformServingRegistryRelease('validate_activation').epoch).toBe(
      38,
    );
    expect(
      platformExecutableRegistryHistory('validate_activation').map(
        ({ epoch }) => epoch,
      ),
    ).toEqual(Array.from({ length: 38 }, (_, index) => index + 1));
    expect(
      PLATFORM_REGISTRY_RELEASE_VALIDATE_STAGED.executors.find(
        ({ executor }) => executor.key === CORE_VALIDATE_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'staged', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_VALIDATE_ACTIVE.executors.find(
        ({ executor }) => executor.key === CORE_VALIDATE_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'active', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_HTTP_STAGED.executors.find(
        ({ executor }) => executor.key === HTTP_REQUEST_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'staged', abiVersion: 2 });
    expect(
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.executors.find(
        ({ executor }) => executor.key === HTTP_REQUEST_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'active', abiVersion: 2 });
    expect(
      PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED.executors.find(
        ({ executor }) => executor.key === CORE_CONDITION_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'staged', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE.executors.find(
        ({ executor }) => executor.key === CORE_CONDITION_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'active', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED.executors.find(
        ({ executor }) => executor.key === CORE_SWITCH_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'staged', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE.executors.find(
        ({ executor }) => executor.key === CORE_SWITCH_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'active', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED.executors.find(
        ({ executor }) => executor.key === CORE_PARALLEL_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'staged', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE.executors.find(
        ({ executor }) => executor.key === CORE_PARALLEL_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'active', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_MERGE_STAGED.executors.find(
        ({ executor }) => executor.key === CORE_MERGE_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'staged', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE.executors.find(
        ({ executor }) => executor.key === CORE_MERGE_EXECUTOR.key,
      ),
    ).toMatchObject({ lifecycle: 'active', abiVersion: 1 });
    expect(
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.definitions.map(
        ({ definition }) => definition,
      ),
    ).toEqual(
      expect.arrayContaining([CORE_SET_DEFINITION, HTTP_REQUEST_DEFINITION]),
    );
    expect(
      new Set(
        PLATFORM_REGISTRY_RELEASE_HISTORY.map(({ fingerprint }) => fingerprint),
      ).size,
    ).toBe(PLATFORM_REGISTRY_RELEASE_HISTORY.length);
  });

  it('executes additive core contract successors without changing retained versions', async () => {
    const successorCohorts = [
      [
        'schedule_v2_staging',
        PLATFORM_SCHEDULE_V2_STAGING_RELEASE_SUPPORT,
        24,
        [24, 25],
      ],
      [
        'schedule_v2_activation',
        PLATFORM_SCHEDULE_V2_ACTIVATION_RELEASE_SUPPORT,
        26,
        [25, 26],
      ],
      [
        'parallel_v2_staging',
        PLATFORM_PARALLEL_V2_STAGING_RELEASE_SUPPORT,
        26,
        [26, 27],
      ],
      [
        'parallel_v2_activation',
        PLATFORM_PARALLEL_V2_ACTIVATION_RELEASE_SUPPORT,
        28,
        [27, 28],
      ],
      [
        'merge_v2_staging',
        PLATFORM_MERGE_V2_STAGING_RELEASE_SUPPORT,
        28,
        [28, 29],
      ],
      [
        'merge_v2_activation',
        PLATFORM_MERGE_V2_ACTIVATION_RELEASE_SUPPORT,
        30,
        [29, 30],
      ],
      [
        'schedule_v3_staging',
        PLATFORM_SCHEDULE_V3_STAGING_RELEASE_SUPPORT,
        30,
        [30, 31],
      ],
      [
        'schedule_v3_activation',
        PLATFORM_SCHEDULE_V3_ACTIVATION_RELEASE_SUPPORT,
        32,
        [31, 32],
      ],
      [
        'parallel_v3_staging',
        PLATFORM_PARALLEL_V3_STAGING_RELEASE_SUPPORT,
        32,
        [32, 33],
      ],
      [
        'parallel_v3_activation',
        PLATFORM_PARALLEL_V3_ACTIVATION_RELEASE_SUPPORT,
        34,
        [33, 34],
      ],
      [
        'merge_v3_staging',
        PLATFORM_MERGE_V3_STAGING_RELEASE_SUPPORT,
        34,
        [34, 35],
      ],
      [
        'merge_v3_activation',
        PLATFORM_MERGE_V3_ACTIVATION_RELEASE_SUPPORT,
        36,
        [35, 36],
      ],
      [
        'validate_staging',
        PLATFORM_VALIDATE_STAGING_RELEASE_SUPPORT,
        36,
        [36, 37],
      ],
      [
        'validate_activation',
        PLATFORM_VALIDATE_ACTIVATION_RELEASE_SUPPORT,
        38,
        [37, 38],
      ],
    ] as const;
    for (const [
      cohort,
      support,
      servingEpoch,
      supportEpochs,
    ] of successorCohorts) {
      expect(platformRegistryReleaseSupport(cohort)).toBe(support);
      expect(support.map(({ epoch }) => epoch)).toEqual(supportEpochs);
      expect(platformServingRegistryRelease(cohort).epoch).toBe(servingEpoch);
    }
    expect(
      platformExecutableRegistryHistory('merge_v2_activation').map(
        ({ epoch }) => epoch,
      ),
    ).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));

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
