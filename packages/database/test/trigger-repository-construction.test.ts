import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  pools: [] as {
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock('../src/platform/postgres-telemetry.js', () => ({
  createDatabasePool: () => {
    const pool = {
      connect: vi.fn(),
      end: vi.fn(() => Promise.resolve()),
      query: vi.fn(),
    };
    database.pools.push(pool);
    return pool;
  },
}));

import type { DatabaseConfig } from '../src/config.js';
import type { CompatibilityReleaseExpectation } from '../src/compatibility/compatibility-release.js';
import { createDatabaseRuntime } from '../src/platform/database-runtime.js';
import { createPublishedWorkflowReader } from '../src/execution/published-workflow-reader.js';
import { createOutboxDispatcherDatabase } from '../src/execution/dispatcher.js';
import { createWorkflowRunDatabase } from '../src/execution/workflow-run-api.js';
import { createScheduleTriggerScanner } from '../src/triggers/schedule-trigger-scanner.js';
import { createWebhookTriggerDatabase } from '../src/triggers/webhook-triggers.js';

const config: DatabaseConfig = {
  connectionString: 'postgresql://runtime:secret@db/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 2_000,
  max: 2,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
};
const acceptanceConfig: DatabaseConfig = {
  ...config,
  connectionString: 'postgresql://api:secret@db/pertexo',
};
const release: CompatibilityReleaseExpectation = Object.freeze({
  epoch: 1,
  fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
  catalogJson:
    '{"domain":"pertexo.node-compatibility-release","schemaVersion":1}',
});

describe('trigger repository construction ownership', () => {
  beforeEach(() => {
    database.pools.length = 0;
  });

  it('rejects invalid webhook compatibility before creating a pool', () => {
    expect(() => createWebhookTriggerDatabase(config, [])).toThrow();
    expect(database.pools).toHaveLength(0);
  });

  it('keeps an injected webhook runtime borrowed and closes owned pools once', async () => {
    const runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
    const borrowed = createWebhookTriggerDatabase(config, release, runtime);
    expect(database.pools).toHaveLength(1);

    await borrowed.close();
    expect(database.pools[0]?.end).not.toHaveBeenCalled();
    await runtime.close();
    expect(database.pools[0]?.end).toHaveBeenCalledOnce();

    const owned = createWebhookTriggerDatabase(config, release);
    await Promise.all([owned.close(), owned.close()]);
    expect(database.pools[1]?.end).toHaveBeenCalledOnce();
  });

  it('rejects invalid scanner compatibility before either pool lease', () => {
    expect(() =>
      createScheduleTriggerScanner(config, [], acceptanceConfig),
    ).toThrow();
    expect(database.pools).toHaveLength(0);
  });

  it('rejects invalid execution-reader compatibility before creating a pool', () => {
    expect(() => createPublishedWorkflowReader(config, [])).toThrow();
    expect(() => createWorkflowRunDatabase(config, [])).toThrow();
    expect(database.pools).toHaveLength(0);
  });

  it('performs no checkout for pre-aborted execution reads', async () => {
    const signal = AbortSignal.abort();
    const reader = createPublishedWorkflowReader(config, release);
    const runs = createWorkflowRunDatabase(config, release);

    await expect(
      reader.readForExecution({
        signal,
        workflowVersionId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      runs.get({
        signal,
        runId: '33333333-3333-4333-8333-333333333333',
        workspaceId: '22222222-2222-4222-8222-222222222222',
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(database.pools[0]?.connect).not.toHaveBeenCalled();
    expect(database.pools[1]?.connect).not.toHaveBeenCalled();
    await Promise.all([reader.close(), runs.close()]);
  });

  it('keeps an execution-reader runtime caller-owned', async () => {
    const runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
    const reader = createPublishedWorkflowReader(config, release, runtime);
    const runs = createWorkflowRunDatabase(config, release, runtime);
    await Promise.all([reader.close(), runs.close()]);
    expect(database.pools[0]?.end).not.toHaveBeenCalled();
    await runtime.close();
    expect(database.pools[0]?.end).toHaveBeenCalledOnce();
  });

  it('does not check out a dispatcher client for empty or invalid allowlists', async () => {
    const dispatcher = createOutboxDispatcherDatabase(config);
    await expect(
      dispatcher.claimBatch({
        enabledJobNames: [],
        leaseDurationMillis: 30_000,
        leaseOwner: 'construction-test',
        leaseToken: '11111111-1111-4111-8111-111111111111',
        limit: 1,
        maxAttempts: 3,
      }),
    ).resolves.toEqual({ events: [], exhaustedCount: 0 });
    await expect(
      dispatcher.observeBacklog({
        enabledJobNames: ['job', 'job'],
      }),
    ).rejects.toThrow();
    expect(database.pools[0]?.connect).not.toHaveBeenCalled();
    expect(database.pools[0]?.query).not.toHaveBeenCalled();
    await dispatcher.close();
  });

  it('rolls back a malformed claim projection before COMMIT', async () => {
    const dispatcher = createOutboxDispatcherDatabase(config);
    const releaseClient = vi.fn();
    const queries: string[] = [];
    const client = {
      query: vi.fn((statement: string) => {
        queries.push(statement.trim().toLowerCase());
        if (statement.includes('coalesce('))
          return Promise.resolve({ rows: [{ events: [{}] }] });
        return Promise.resolve({ rows: [] });
      }),
      release: releaseClient,
    };
    database.pools[0]?.connect.mockResolvedValue(client);

    await expect(
      dispatcher.claimBatch({
        enabledJobNames: ['job'],
        leaseDurationMillis: 30_000,
        leaseOwner: 'construction-test',
        leaseToken: '11111111-1111-4111-8111-111111111111',
        limit: 1,
        maxAttempts: 3,
      }),
    ).rejects.toThrow();
    expect(queries.at(-1)).toBe('rollback');
    expect(queries).not.toContain('commit');
    expect(releaseClient).toHaveBeenCalledWith(undefined);
    await dispatcher.close();
  });

  it('disposes a client when rollback of an invalid claim also fails', async () => {
    const dispatcher = createOutboxDispatcherDatabase(config);
    const rollbackFailure = new Error('rollback failed');
    const releaseClient = vi.fn();
    const client = {
      query: vi.fn((statement: string) => {
        if (statement.includes('coalesce('))
          return Promise.resolve({ rows: [{ events: [{}] }] });
        if (statement.trim().toLowerCase() === 'rollback')
          return Promise.reject(rollbackFailure);
        return Promise.resolve({ rows: [] });
      }),
      release: releaseClient,
    };
    database.pools[0]?.connect.mockResolvedValue(client);

    await expect(
      dispatcher.claimBatch({
        enabledJobNames: ['job'],
        leaseDurationMillis: 30_000,
        leaseOwner: 'construction-test',
        leaseToken: '11111111-1111-4111-8111-111111111111',
        limit: 1,
        maxAttempts: 3,
      }),
    ).rejects.not.toBe(rollbackFailure);
    expect(releaseClient).toHaveBeenCalledWith(true);
    await dispatcher.close();
  });

  it('reports a rejected COMMIT as uncertain and disposes the client', async () => {
    const dispatcher = createOutboxDispatcherDatabase(config);
    const commitFailure = new Error('commit acknowledgement lost');
    const releaseClient = vi.fn();
    const event = {
      aggregate_id: '22222222-2222-4222-8222-222222222222',
      aggregate_type: 'workflow-run',
      available_at: new Date('2026-01-01T00:00:00.000Z'),
      id: '11111111-1111-4111-8111-111111111111',
      job_name: 'job',
      lease_expires_at: new Date('2026-01-01T00:00:30.000Z'),
      lease_owner: 'construction-test',
      lease_token: '33333333-3333-4333-8333-333333333333',
      payload: {},
      payload_checksum: 'a'.repeat(64),
      publish_attempts: 1,
      schema_version: 1,
      workspace_id: '44444444-4444-4444-8444-444444444444',
    };
    const queries: string[] = [];
    const client = {
      query: vi.fn((statement: string) => {
        const normalized = statement.trim().toLowerCase();
        queries.push(normalized);
        if (statement.includes('coalesce('))
          return Promise.resolve({
            rows: [
              {
                events: [event],
                exhausted_count: 0,
                cursor_update_count: 1,
                released_admission_count: 0,
              },
            ],
          });
        if (normalized === 'commit') return Promise.reject(commitFailure);
        return Promise.resolve({ rows: [] });
      }),
      release: releaseClient,
    };
    database.pools[0]?.connect.mockResolvedValue(client);

    await expect(
      dispatcher.claimBatch({
        enabledJobNames: ['job'],
        leaseDurationMillis: 30_000,
        leaseOwner: 'construction-test',
        leaseToken: '33333333-3333-4333-8333-333333333333',
        limit: 1,
        maxAttempts: 3,
      }),
    ).rejects.toBe(commitFailure);
    expect(queries).not.toContain('rollback');
    expect(releaseClient).toHaveBeenCalledWith(true);
    await dispatcher.close();
  });

  it('closes the first scanner lease when the second acquisition fails', async () => {
    const wrongAcceptanceRuntime = createDatabaseRuntime(config, {
      monitorLockWaits: false,
    });
    expect(() =>
      createScheduleTriggerScanner(config, release, acceptanceConfig, {
        acceptance: wrongAcceptanceRuntime,
      }),
    ).toThrow('authority does not match');
    await Promise.resolve();

    expect(database.pools).toHaveLength(2);
    expect(database.pools[1]?.end).toHaveBeenCalledOnce();
    expect(database.pools[0]?.end).not.toHaveBeenCalled();
    await wrongAcceptanceRuntime.close();
    expect(database.pools[0]?.end).toHaveBeenCalledOnce();
  });

  it('attempts both scanner closers and keeps borrowed runtimes open', async () => {
    const claimRuntime = createDatabaseRuntime(config, {
      monitorLockWaits: false,
    });
    const acceptanceRuntime = createDatabaseRuntime(acceptanceConfig, {
      monitorLockWaits: false,
    });
    const scanner = createScheduleTriggerScanner(
      config,
      release,
      acceptanceConfig,
      { acceptance: acceptanceRuntime, claim: claimRuntime },
    );

    await scanner.close();
    expect(database.pools[0]?.end).not.toHaveBeenCalled();
    expect(database.pools[1]?.end).not.toHaveBeenCalled();
    await Promise.all([claimRuntime.close(), acceptanceRuntime.close()]);
    expect(database.pools[0]?.end).toHaveBeenCalledOnce();
    expect(database.pools[1]?.end).toHaveBeenCalledOnce();
  });

  it('attempts both owned scanner closers when each rejects', async () => {
    const scanner = createScheduleTriggerScanner(
      config,
      release,
      acceptanceConfig,
    );
    const firstFailure = new Error('claim pool close failed');
    const secondFailure = new Error('acceptance pool close failed');
    database.pools[0]?.end.mockRejectedValueOnce(firstFailure);
    database.pools[1]?.end.mockRejectedValueOnce(secondFailure);

    await expect(scanner.close()).rejects.toEqual(
      new AggregateError(
        [firstFailure, secondFailure],
        'Schedule scanner close failed',
      ),
    );
    expect(database.pools[0]?.end).toHaveBeenCalledOnce();
    expect(database.pools[1]?.end).toHaveBeenCalledOnce();
  });
});
