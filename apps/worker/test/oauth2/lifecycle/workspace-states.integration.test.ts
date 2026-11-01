import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeOAuth2,
  startOAuth2Harness,
  useOAuth2Timeouts,
  type Connection,
  type OAuth2Harness,
  type Owner,
} from '../../support/oauth2/harness.js';

useOAuth2Timeouts();

describeOAuth2('an OAuth2 connection in a workspace that isn’t active', () => {
  let harness: OAuth2Harness;

  beforeAll(async () => {
    harness = await startOAuth2Harness('life-workspace-states');
  });
  afterAll(async () => {
    await harness.close();
  });

  const root = (owner: Owner) => `/v1/workspaces/${owner.workspaceId}`;

  const list = (owner: Owner) =>
    owner.api.call('GET', `${root(owner)}/connections`);

  /** Lifecycle changes end sessions, as they do for a real person. */
  const signInAgain = (owner: Owner) => owner.api.signIn(owner.email);

  const requestDeletion = async (owner: Owner) => {
    const requested = await owner.api.call(
      'POST',
      `${root(owner)}/deletion`,
      { reason: 'Testing what deletion leaves behind' },
      { 'idempotency-key': randomUUID() },
    );
    expect(requested.status, JSON.stringify(requested.json)).toBe(200);
    await signInAgain(owner);
  };

  const restore = async (owner: Owner) => {
    const restored = await owner.api.call(
      'DELETE',
      `${root(owner)}/deletion`,
      undefined,
      { 'idempotency-key': randomUUID() },
    );
    expect(restored.status, JSON.stringify(restored.json)).toBe(200);
    await signInAgain(owner);
  };

  const lift = async (owner: Owner) => {
    const lifted = await owner.api.call(
      'POST',
      `${root(owner)}/reactivate`,
      {},
      { 'idempotency-key': randomUUID() },
    );
    expect(lifted.status, JSON.stringify(lifted.json)).toBe(200);
    await signInAgain(owner);
  };

  const suspend = async (owner: Owner) => {
    await harness.stack.sql(
      `update app.workspaces set status='suspended' where id=$1`,
      [owner.workspaceId],
    );
    await signInAgain(owner);
  };

  /** A consent the person has approved, ready to come back. */
  const pendingCallback = async (owner: Owner, connection: Connection) =>
    harness.decide(
      harness.authorizationUrl(
        await harness.start(owner.api, owner, connection.id),
      ),
      'approve',
    );

  const reconnects = async (owner: Owner, connection: Connection) => {
    expect((await harness.reconnect(owner, connection)).result).toBe(
      'connected',
    );
    expect(await harness.connection(connection.id)).toMatchObject({
      status: 'active',
      last_error_code: null,
    });
    const runId = await harness.run(owner, {
      connectionId: connection.id,
      method: 'GET',
      url: harness.apiUrl(),
    });
    expect((await harness.finish(runId)).status).toBe('succeeded');
  };

  // M1, L7: a refresh token must not stay stored for the 30-day recovery window.
  it('M1 requesting deletion removes token and pending rows', async () => {
    const owner = await harness.newOwner();
    const connected = await harness.connected(owner, 'non-rotating');
    const pending = await harness.create(owner, 'non-rotating');
    await harness.start(owner.api, owner, pending.id);
    expect(await harness.pendingRows(pending.id)).toBe(1);
    await requestDeletion(owner);
    expect(await harness.tokenRow(connected.id)).toBeUndefined();
    expect(await harness.pendingRows(pending.id)).toBe(0);
    expect(await harness.connection(connected.id)).toMatchObject({
      status: 'reauthorization_required',
      last_error_code: 'workspace.pending_deletion',
    });
  });

  // M1: one such connection took the list, the picker and the overview down.
  it('M1 after a restore the connection is listed and readable, suspended and lifted', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    await requestDeletion(owner);
    await restore(owner);
    const suspended = await list(owner);
    expect(suspended.status, JSON.stringify(suspended.json)).toBe(200);
    expect(JSON.stringify(suspended.json)).toContain(connection.id);
    expect((await harness.read(owner.api, owner, connection.id)).status).toBe(
      200,
    );
    await lift(owner);
    const lifted = await list(owner);
    expect(lifted.status).toBe(200);
    const detail = await harness.read(owner.api, owner, connection.id);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ status: 'reauthorization_required' });
    expect(detail.json).not.toHaveProperty('grant');
  });

  // M1: the whole way back: Reconnect is what the page offers.
  it('M1 a restored and lifted workspace can reconnect and run', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    await requestDeletion(owner);
    await restore(owner);
    await lift(owner);
    await reconnects(owner, connection);
  });

  // M1, ADR 013: restoring revives nothing, so a client still needs signing in.
  it('M1 a connection never connected stays unconnected through it all', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    await requestDeletion(owner);
    await restore(owner);
    await lift(owner);
    expect((await list(owner)).status).toBe(200);
    expect((await harness.connection(connection.id)).status).toBe(
      'reauthorization_required',
    );
    await reconnects(owner, connection);
  });

  it('a pending-deletion workspace can’t start a consent', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    await requestDeletion(owner);
    const started = await harness.start(owner.api, owner, connection.id);
    expect(started.status, JSON.stringify(started.json)).toBe(404);
    expect(harness.standIn.authorizeRequests(connection.clientId)).toEqual([]);
  });

  // S6's recheck: a consent begun before the request can't connect after it.
  it('a consent returning to a pending-deletion workspace connects nothing', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const callbackUrl = await pendingCallback(owner, connection);
    await requestDeletion(owner);
    const landing = await harness.land(owner.api, callbackUrl);
    expect(landing.result).toBe('invalid');
    expect(harness.standIn.tokenRequests(connection.clientId)).toEqual([]);
    expect(await harness.tokenRow(connection.id)).toBeUndefined();
  });

  // ADR 013, 027: a suspended workspace reads but does not change.
  it('a suspended workspace shows a healthy connection, with its grant', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    await suspend(owner);
    const listed = await list(owner);
    expect(listed.status, JSON.stringify(listed.json)).toBe(200);
    const detail = await harness.read(owner.api, owner, connection.id);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ status: 'active' });
    expect(detail.json).toHaveProperty('grant');
  });

  it('a suspended workspace can’t start a consent', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    await suspend(owner);
    const started = await harness.start(owner.api, owner, connection.id);
    expect(started.status, JSON.stringify(started.json)).toBe(404);
    expect(await harness.pendingRows(connection.id)).toBe(0);
  });

  it('a consent returning to a suspended workspace connects nothing', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const callbackUrl = await pendingCallback(owner, connection);
    await suspend(owner);
    const landing = await harness.land(owner.api, callbackUrl);
    expect(landing.result).toBe('invalid');
    expect(harness.standIn.tokenRequests(connection.clientId)).toEqual([]);
    expect(await harness.tokenRow(connection.id)).toBeUndefined();
  });

  it('a suspended workspace can’t use a connection’s token', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    await suspend(owner);
    const tested = await harness.test(
      owner,
      connection.id,
      'https://api.public.example.test/api',
    );
    expect(tested.status, JSON.stringify(tested.json)).toBe(404);
    expect(harness.standIn.apiCalls(connection.clientId)).toEqual([]);
  });
});
