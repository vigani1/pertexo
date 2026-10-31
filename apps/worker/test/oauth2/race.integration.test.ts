import { afterAll, beforeAll, expect, it } from 'vitest';

import type { OAuth2StandInHold } from '../../../../infrastructure/testing/oauth2-stand-in.mjs';
import {
  describeOAuth2,
  startOAuth2Harness,
  useOAuth2Timeouts,
  type Connection,
  type OAuth2Harness,
  type Owner,
} from '../support/oauth2/harness.js';
import type { ServiceProcess } from '../support/recovery/processes.js';

useOAuth2Timeouts();

const WORKER_START_MS = 120_000;
const COMMIT_LIMIT_MS = 15_000;
const RUNNING_LIMIT_MS = 30_000;

describeOAuth2('two real workers refreshing one connection', () => {
  let harness: OAuth2Harness;
  let owner: Owner;
  let first: ServiceProcess;
  let second: ServiceProcess;

  beforeAll(async () => {
    harness = await startOAuth2Harness('race');
    owner = await harness.newOwner();
    first = harness.stack.worker;
    second = harness.stack.createWorker('oauth2-worker-second');
    second.start();
    await second.waitForLog(/worker\.started/u, WORKER_START_MS);
    second.signal('SIGSTOP');
  });
  afterAll(async () => {
    first.signal('SIGCONT');
    second.signal('SIGCONT');
    await harness.close();
  });

  /** Tokens lost nothing and a connection stayed whole: what every race must end on. */
  const expectHealthy = async (connection: Connection): Promise<void> => {
    expect((await harness.connection(connection.id)).status).toBe('active');
    expect(await harness.tokenRow(connection.id)).toBeDefined();
  };

  const startRun = (connection: Connection): Promise<string> =>
    harness.run(owner, {
      connectionId: connection.id,
      method: 'GET',
      url: harness.apiUrl(),
    });

  /**
   * The first worker's refresh is at the service, frozen there. Frozen it can't take
   * the next run, so that goes to the second worker, for real, every time.
   */
  const firstWorkerHolds = async (
    connection: Connection,
    hold: OAuth2StandInHold,
  ): Promise<string> => {
    const runId = await startRun(connection);
    await hold.arrived;
    first.signal('SIGSTOP');
    second.signal('SIGCONT');
    return runId;
  };

  /** Back to how each test starts: only the first worker takes work. */
  const reset = async (): Promise<void> => {
    first.signal('SIGCONT');
    second.signal('SIGSTOP');
    await Promise.resolve();
  };

  const attemptOwner = async (runId: string): Promise<string | null> => {
    const [row] = await harness.stack.sql<{ lease_owner: string | null }>(
      `select a.lease_owner from app.node_attempts a
         join app.node_runs n on n.id=a.node_run_id and n.workspace_id=a.workspace_id
        where n.workflow_run_id=$1 and n.node_id='call'
        order by a.attempt_number desc limit 1`,
      [runId],
    );
    return row?.lease_owner ?? null;
  };

  // L1: two workers needing the same refresh make one token request; both use the new token.
  it('L1 one token request against a rotating provider with reuse detection', async () => {
    const { standIn } = harness;
    const connection = await harness.connected(owner, 'rotating-reuse');
    await harness.expireToken(connection.id);
    const exchanged = standIn.tokenRequests(connection.clientId).length;
    const hold = standIn.holdNextToken(connection.clientId);
    try {
      const firstRun = await firstWorkerHolds(connection, hold);
      const secondRun = await startRun(connection);
      await expect
        .poll(() => attemptOwner(secondRun), { timeout: RUNNING_LIMIT_MS })
        .toMatch(/./u);
      expect(await attemptOwner(secondRun)).not.toBe(
        await attemptOwner(firstRun),
      );
      first.signal('SIGCONT');
      hold.release();
      expect((await harness.finish(firstRun)).status).toBe('succeeded');
      expect((await harness.finish(secondRun)).status).toBe('succeeded');
    } finally {
      await reset();
    }
    const refreshes = standIn
      .tokenRequests(connection.clientId)
      .slice(exchanged);
    expect(refreshes).toHaveLength(1);
    // Both steps used what that one request issued.
    const issued = `Bearer ${String(refreshes[0]?.issued?.accessToken)}`;
    const used = standIn
      .apiCalls(connection.clientId)
      .map(({ headers }) => headers.authorization);
    expect(used).toEqual([issued, issued]);
    await expectHealthy(connection);
  });

  /**
   * L3's race, forced: the block is cleared so the second worker also calls. Each
   * request is held at the service, and the test decides who is answered first.
   */
  const lateRotation = async (
    answerFirst: 'first-worker' | 'second-worker',
  ): Promise<Connection> => {
    const { standIn } = harness;
    const connection = await harness.connected(owner, 'rotating');
    await harness.expireToken(connection.id);
    const firstHold = standIn.holdNextToken(connection.clientId);
    const secondHold = standIn.holdNextToken(connection.clientId);
    try {
      const firstRun = await firstWorkerHolds(connection, firstHold);
      await harness.stack.sql(
        `update app.connection_oauth2_tokens set refresh_blocked_until=null where connection_id=$1`,
        [connection.id],
      );
      const secondRun = await startRun(connection);
      await secondHold.arrived;
      first.signal('SIGCONT');
      const before = (await harness.tokenRow(connection.id))?.id;
      const [winner, loser] =
        answerFirst === 'first-worker'
          ? [firstHold, secondHold]
          : [secondHold, firstHold];
      winner.release();
      // The renewed tokens are stored before the loser hears invalid_grant.
      await expect
        .poll(async () => (await harness.tokenRow(connection.id))?.id, {
          timeout: COMMIT_LIMIT_MS,
        })
        .not.toBe(before);
      loser.release();
      expect((await harness.finish(firstRun)).status).toBe('succeeded');
      expect((await harness.finish(secondRun)).status).toBe('succeeded');
    } finally {
      await reset();
    }
    return connection;
  };

  // L3: a late invalid_grant can't break a renewed connection.
  it('L3 a late invalid_grant leaves the renewed connection active', async () => {
    const { standIn } = harness;
    const connection = await lateRotation('first-worker');
    const answers = standIn
      .tokenRequests(connection.clientId)
      .filter(({ form }) => form?.grant_type === 'refresh_token');
    expect(answers).toHaveLength(2);
    expect(await harness.events(connection.id)).not.toContain(
      'connection.reauthorization_required',
    );
    await expectHealthy(connection);
  });

  // Proof list: "The reverse commit order gives the same result."
  it('L3 the same when the second worker is answered first', async () => {
    const connection = await lateRotation('second-worker');
    expect(await harness.events(connection.id)).not.toContain(
      'connection.reauthorization_required',
    );
    await expectHealthy(connection);
  });

  // L2: a loser writes nothing: after a late rotation the winner's refresh token still works.
  it('L2 the row holds the winner’s tokens after the race', async () => {
    const { standIn } = harness;
    const connection = await lateRotation('first-worker');
    await harness.expireToken(connection.id);
    const runId = await startRun(connection);
    expect((await harness.finish(runId)).status).toBe('succeeded');
    await expectHealthy(connection);
    const refreshes = standIn
      .tokenRequests(connection.clientId)
      .filter(({ form }) => form?.grant_type === 'refresh_token');
    // The third refresh presented what the winning request was issued.
    const [winnerRefresh] = refreshes
      .slice(0, 2)
      .flatMap(({ issued }) =>
        issued?.refreshToken === undefined ? [] : [issued.refreshToken],
      );
    expect(refreshes[2]?.form?.refresh_token).toBe(winnerRefresh);
  });

  /**
   * A gap in the plan, stated in the notes: the worker told invalid_grant acts before
   * the winner commits, so its version check passes. L2 then discards the winner's
   * tokens. Nothing closes this without a lock; what must hold is L7 and no stuck run.
   */
  it('L7 holds when invalid_grant is handled before the winner commits', async () => {
    const { standIn } = harness;
    const connection = await harness.connected(owner, 'rotating');
    await harness.expireToken(connection.id);
    const firstHold = standIn.holdNextToken(connection.clientId);
    const secondHold = standIn.holdNextToken(connection.clientId);
    let firstRun = '';
    let secondRun = '';
    try {
      firstRun = await firstWorkerHolds(connection, firstHold);
      await harness.stack.sql(
        `update app.connection_oauth2_tokens set refresh_blocked_until=null where connection_id=$1`,
        [connection.id],
      );
      secondRun = await startRun(connection);
      await secondHold.arrived;
      // The first request rotates at the service while its worker stays frozen.
      firstHold.release();
      await new Promise((resolve) => setTimeout(resolve, 250));
      secondHold.release();
      // The second worker has acted on invalid_grant while the winner stays frozen.
      await expect
        .poll(() => harness.tokenRow(connection.id), {
          timeout: COMMIT_LIMIT_MS,
        })
        .toBeUndefined();
      first.signal('SIGCONT');
      await harness.finish(firstRun);
      await harness.finish(secondRun);
    } finally {
      await reset();
    }
    const stored = await harness.connection(connection.id);
    const token = await harness.tokenRow(connection.id);
    expect(token !== undefined).toBe(stored.status === 'active');
    if (stored.status !== 'active')
      expect(stored.last_error_code).toBe('connection.oauth2_grant_revoked');
  });

  // Proof list: a person reconnects during a refresh: its commit is discarded.
  it('L2 a reconnect during a refresh wins, and the refresh’s commit is discarded', async () => {
    const { standIn } = harness;
    const connection = await harness.connected(owner, 'rotating');
    standIn.acceptAnyRefresh(connection.clientId);
    await harness.expireToken(connection.id);
    const hold = standIn.holdNextToken(connection.clientId);
    const runId = await startRun(connection);
    await hold.arrived;
    expect((await harness.reconnect(owner, connection)).result).toBe(
      'connected',
    );
    const reconnected = await harness.tokenRow(connection.id);
    const consent = standIn
      .tokenRequests(connection.clientId)
      .filter(({ form }) => form?.grant_type === 'authorization_code')
      .at(-1);
    hold.release();
    expect((await harness.finish(runId)).status).toBe('succeeded');
    expect((await harness.tokenRow(connection.id))?.id).toBe(reconnected?.id);
    await expectHealthy(connection);
    // The step started over with the person's new token, not the refresh's.
    expect(
      standIn.apiCalls(connection.clientId).at(-1)?.headers.authorization,
    ).toBe(`Bearer ${String(consent?.issued?.accessToken)}`);
    await harness.expireToken(connection.id);
    const nextRun = await startRun(connection);
    expect((await harness.finish(nextRun)).status).toBe('succeeded');
    expect(
      standIn
        .tokenRequests(connection.clientId)
        .filter(({ form }) => form?.grant_type === 'refresh_token')
        .at(-1)?.form?.refresh_token,
    ).toBe(consent?.issued?.refreshToken);
  });

  // L4: canceling a step lets the request and commit finish.
  it('L4 a canceled step still commits the rotated tokens', async () => {
    const { standIn } = harness;
    const connection = await harness.connected(owner, 'rotating');
    await harness.expireToken(connection.id);
    const before = await harness.tokenRow(connection.id);
    const hold = standIn.holdNextToken(connection.clientId);
    const runId = await startRun(connection);
    await hold.arrived;
    expect((await owner.api.cancelRun(owner.workspaceId, runId)).status).toBe(
      200,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    hold.release();
    expect((await harness.finish(runId)).status).toBe('canceled');
    await expect
      .poll(async () => (await harness.tokenRow(connection.id))?.id, {
        timeout: COMMIT_LIMIT_MS,
      })
      .not.toBe(before?.id);
    expect(standIn.apiCalls(connection.clientId)).toEqual([]);
    const [refresh] = standIn
      .tokenRequests(connection.clientId)
      .filter(({ form }) => form?.grant_type === 'refresh_token');
    await harness.expireToken(connection.id);
    const nextRun = await startRun(connection);
    expect((await harness.finish(nextRun)).status).toBe('succeeded');
    expect(
      standIn
        .tokenRequests(connection.clientId)
        .filter(({ form }) => form?.grant_type === 'refresh_token')
        .at(-1)?.form?.refresh_token,
    ).toBe(refresh?.issued?.refreshToken);
    await expectHealthy(connection);
  });

  // Getting a token, step 5: claim lost and token not expired returns the current token.
  it('a step doesn’t wait for a refresh while its token is still good', async () => {
    const { standIn } = harness;
    const connection = await harness.connected(owner, 'non-rotating');
    await harness.expireToken(connection.id, 30);
    const hold = standIn.holdNextToken(connection.clientId);
    try {
      const firstRun = await firstWorkerHolds(connection, hold);
      const secondRun = await startRun(connection);
      // The other worker's step finishes while the refresh is still held.
      expect((await harness.finish(secondRun)).status).toBe('succeeded');
      first.signal('SIGCONT');
      hold.release();
      expect((await harness.finish(firstRun)).status).toBe('succeeded');
    } finally {
      await reset();
    }
    await expectHealthy(connection);
  });

  // Constants: wait 20 s for another worker's refresh, then fail with refresh_busy.
  it('a step that waits too long for a refresh says it is busy', async () => {
    const { standIn } = harness;
    const connection = await harness.connected(owner, 'non-rotating');
    await harness.expireToken(connection.id);
    // A block no worker holds: the first claim was lost long ago.
    await harness.stack.sql(
      `update app.connection_oauth2_tokens
          set refresh_blocked_until = clock_timestamp() + interval '40 seconds'
        where connection_id=$1`,
      [connection.id],
    );
    const exchanged = standIn.tokenRequests(connection.clientId).length;
    const runId = await harness.run(owner, {
      connectionId: connection.id,
      method: 'GET',
      url: harness.apiUrl(),
      retry: { maximumAttempts: 1, delayMillis: 1_000 },
    });
    await harness.finish(runId);
    const [attempt] = await harness.attempts(runId);
    expect(attempt).toMatchObject({
      safe_error_code: 'http.oauth2_refresh_busy',
      error_summary: "Another step is renewing this connection's token.",
      executor_possibly_dispatched: false,
    });
    expect(standIn.tokenRequests(connection.clientId).length).toBe(exchanged);
    await expectHealthy(connection);
  });
});
