import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import { delay, waitForRunsToEnd } from '../support/recovery/facts.js';
import type { ServiceProcess } from '../support/recovery/processes.js';
import { startService, stopService } from '../support/recovery/services.js';
import {
  startOAuth2Harness,
  type Connection,
  type OAuth2Harness,
  type Owner,
} from '../support/oauth2/harness.js';

const REFRESH_BLOCK_S = 45;
const COMMIT_ATTEMPTS_MS = 3 * 1_000;
const WORKER_START_MS = 120_000;
const TERMINAL = [
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
];

/** A worker dies, Postgres restarts, Redis goes away, all while a token is on its way back. */
describeFaults('OAuth2 tokens through real faults', () => {
  let harness: OAuth2Harness;
  let owner: Owner;
  /** The one taking work: each kill below replaces it. */
  let worker: ServiceProcess;

  const startRun = (connection: Connection, method: 'GET' | 'POST' = 'GET') =>
    harness.run(owner, {
      connectionId: connection.id,
      method,
      url: harness.apiUrl(),
    });

  const endOf = async (runId: string): Promise<string> => {
    const facts = await waitForRunsToEnd(
      harness.stack,
      [runId],
      RECOVERY_LIMIT_MS,
    );
    return facts[runId]?.status ?? 'missing';
  };

  const restartWorker = async (name: string): Promise<void> => {
    worker = harness.stack.createWorker(name);
    worker.start();
    await worker.waitForLog(/worker\.started/u, WORKER_START_MS);
  };

  beforeAll(async () => {
    harness = await startOAuth2Harness('faults');
    owner = await harness.newOwner();
    worker = harness.stack.worker;
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await startService('postgres').catch(() => undefined);
    await startService('redis').catch(() => undefined);
    await harness.close();
  }, SCENARIO_LIMIT_MS);

  // Proof list, L1 constants: the block lifts by itself after 45 s, and nothing stays stuck.
  it(
    'SIGKILL while holding a block: another worker renews after 45 s',
    async () => {
      const { standIn } = harness;
      const connection = await harness.connected(owner, 'non-rotating');
      await harness.expireToken(connection.id);
      const exchanged = standIn.tokenRequests(connection.clientId).length;
      const hold = standIn.holdNextToken(connection.clientId);
      const runId = await startRun(connection);
      await hold.arrived;

      const blocked = await harness.tokenRow(connection.id);
      expect(blocked?.refresh_blocked_until).not.toBeNull();
      await worker.stop('SIGKILL');
      hold.release();

      await restartWorker('oauth2-after-block');
      expect(await endOf(runId)).toBe('succeeded');
      const requests = standIn
        .tokenRequests(connection.clientId)
        .slice(exchanged);
      expect(requests).toHaveLength(2);
      const waited = ((requests[1]?.at ?? 0) - (requests[0]?.at ?? 0)) / 1_000;
      expect(waited).toBeGreaterThanOrEqual(REFRESH_BLOCK_S - 1);
      expect((await harness.connection(connection.id)).status).toBe('active');
    },
    SCENARIO_LIMIT_MS,
  );

  // Proof list, L8: the accepted window: the next use says so, and reconnect restores it.
  it(
    'SIGKILL between the token response and commit: next use shows revoked, reconnect restores',
    async () => {
      const { standIn } = harness;
      const connection = await harness.connected(owner, 'rotating');
      await harness.expireToken(connection.id);
      const hold = standIn.holdNextToken(connection.clientId);
      const runId = await startRun(connection);
      await hold.arrived;
      await worker.stop('SIGKILL');
      // The service rotates and answers a worker that no longer exists.
      hold.release();
      await delay(500);

      await restartWorker('oauth2-after-rotation');
      expect(await endOf(runId)).toBe('failed');
      const attempts = await harness.attempts(runId);
      expect(attempts.at(-1)).toMatchObject({
        safe_error_code: 'http.oauth2_grant_revoked',
        error_summary:
          "The service no longer accepts this connection's sign-in. Reconnect it in Connections.",
      });
      expect(await harness.connection(connection.id)).toMatchObject({
        status: 'reauthorization_required',
        last_error_code: 'connection.oauth2_grant_revoked',
      });
      expect(await harness.tokenRow(connection.id)).toBeUndefined();

      expect((await harness.reconnect(owner, connection)).result).toBe(
        'connected',
      );
      const restored = await startRun(connection);
      expect(await endOf(restored)).toBe('succeeded');
    },
    SCENARIO_LIMIT_MS,
  );

  /** Whatever the path, the plan's two "never"s, checked by really using the connection. */
  const expectVisibleAndWorking = async (
    connection: Connection,
  ): Promise<void> => {
    const stored = await harness.connection(connection.id);
    if (stored.status === 'active') {
      await harness.expireToken(connection.id);
      expect(await endOf(await startRun(connection))).toBe('succeeded');
    } else {
      expect(stored.status).toBe('reauthorization_required');
      expect(stored.last_error_code).toMatch(/^connection\.oauth2_/u);
    }
  };

  // Proof list, L8: Postgres back within the commit attempts: tokens committed.
  it(
    'Postgres restarting during commit: a later attempt commits',
    async () => {
      const { standIn } = harness;
      const connection = await harness.connected(owner, 'rotating');
      await harness.expireToken(connection.id);
      const hold = standIn.holdNextToken(connection.clientId);
      const before = await harness.tokenRow(connection.id);
      const runId = await startRun(connection);
      await hold.arrived;
      await stopService('postgres');
      hold.release();
      await delay(COMMIT_ATTEMPTS_MS - 2_000);
      await startService('postgres');
      expect(TERMINAL).toContain(await endOf(runId));
      await expectVisibleAndWorking(connection);
      if ((await harness.connection(connection.id)).status === 'active')
        expect((await harness.tokenRow(connection.id))?.id).not.toBe(
          before?.id,
        );
    },
    SCENARIO_LIMIT_MS,
  );

  // Proof list, L8: Postgres away for longer than the attempts: visible, never stuck.
  it(
    'Postgres down past all three attempts: visible state, no stuck run',
    async () => {
      const { standIn } = harness;
      const connection = await harness.connected(owner, 'rotating');
      await harness.expireToken(connection.id);
      const hold = standIn.holdNextToken(connection.clientId);
      const runId = await startRun(connection);
      await hold.arrived;
      await stopService('postgres');
      hold.release();
      await delay(COMMIT_ATTEMPTS_MS * 4);
      await startService('postgres');
      expect(TERMINAL).toContain(await endOf(runId));
      await expectVisibleAndWorking(connection);
    },
    SCENARIO_LIMIT_MS,
  );

  // Proof list: "the existing provider rate limit behavior applies".
  it(
    'Redis down during a second credential read: the limiter answers, the grant stands',
    async () => {
      const connection = await harness.connected(owner, 'api-401-page-3');
      await harness.ageToken(connection.id);
      const runId = await harness.run(owner, {
        connectionId: connection.id,
        method: 'GET',
        url: harness.apiUrl('/api/pages?page=1'),
        pagination: {
          mode: 'next_link',
          source: { kind: 'body', path: '$.next' },
          itemsPath: '$.items',
          maxPages: 10,
          delayMillis: 5_000,
        },
      });
      await expect
        .poll(() => harness.standIn.apiCalls(connection.clientId).length, {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(2);
      await stopService('redis');
      await delay(12_000);
      await startService('redis');
      expect(TERMINAL).toContain(await endOf(runId));
      // Redis is no part of a grant: tokens and status come through it unchanged.
      expect((await harness.connection(connection.id)).status).toBe('active');
      expect(await harness.tokenRow(connection.id)).toBeDefined();
      await expectVisibleAndWorking(connection);
    },
    SCENARIO_LIMIT_MS,
  );
});
