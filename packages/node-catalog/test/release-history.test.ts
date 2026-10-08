import { describe, expect, it, vi } from 'vitest';
import {
  HTTP_REQUEST_EXECUTOR,
  SLACK_SEND_MESSAGE_EXECUTOR,
  EMAIL_SEND_NOTIFICATION_EXECUTOR,
} from '@pertexo/integrations';
import {
  CORE_CONDITION_DEFINITION,
  CORE_CONDITION_EXECUTOR,
  CORE_MERGE_DEFINITION_V2,
  CORE_MERGE_DEFINITION_V3,
  CORE_MERGE_EXECUTOR,
  CORE_MERGE_EXECUTOR_V2,
  CORE_MERGE_EXECUTOR_V3,
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

describe('platform node release history', () => {
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

  it('serves the newest release and retains staged/active lifecycle history in order', () => {
    const serving = platformServingRegistryRelease();
    expect(platformRegistryReleaseSupport()).toEqual([serving]);
    expect(serving.epoch).toBe(
      PLATFORM_REGISTRY_RELEASE_VALIDATE_ACTIVE.epoch + 1,
    );
    expect(
      [...serving.definitions, ...serving.executors].every(
        ({ lifecycle }) => lifecycle === 'active',
      ),
    ).toBe(true);
    expect(platformServingReleaseRequiresHttpCapabilities()).toBe(true);
    expect(platformExecutableRegistryHistory()).toEqual([
      ...PLATFORM_REGISTRY_RELEASE_HISTORY,
      serving,
    ]);
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

  it.each(PLATFORM_LIFECYCLE_EXPECTATIONS)(
    'proves $label is absent before staging and cannot dispatch while staged',
    (expectation) => {
      const stagedManifest = expectation.staged.definitions.find(
        ({ executor: candidate }) =>
          candidate.key === expectation.executor.key &&
          candidate.version === expectation.executor.version,
      );
      expect(
        stagedManifest,
        `${expectation.label} staged manifest`,
      ).toBeDefined();
      if (stagedManifest === undefined) return;
      const predecessor = PLATFORM_REGISTRY_RELEASE_HISTORY.find(
        ({ epoch }) => epoch === expectation.staged.epoch - 1,
      );
      expect(predecessor, `${expectation.label} predecessor`).toBeDefined();
      if (predecessor === undefined) return;

      expect(() =>
        resolvePlatformNodeDefinitionForRelease(
          predecessor,
          stagedManifest.definition,
        ),
      ).toThrow(/not implemented/u);
      const providerDispatch = vi.fn();
      expect(() =>
        createPlatformNodeRegistryForRelease(expectation.staged, {
          httpRequest: {
            httpClient: { executeStreaming: providerDispatch } as never,
          },
          slackSendMessage: {
            client: { sendMessage: providerDispatch },
          },
          emailSendNotification: {
            client: { sendNotification: providerDispatch },
          },
        }),
      ).toThrow(/cannot execute this release/u);
      expect(providerDispatch).not.toHaveBeenCalled();
    },
  );

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
