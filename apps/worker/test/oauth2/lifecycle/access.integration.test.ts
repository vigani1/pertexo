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

const TEST_URL = 'https://api.public.example.test/api';

describeOAuth2('who may do what, and the connection test', () => {
  let harness: OAuth2Harness;

  beforeAll(async () => {
    harness = await startOAuth2Harness('life-access');
  });
  afterAll(async () => {
    await harness.close();
  });

  const replace = (owner: Owner, connection: Connection, credential: unknown) =>
    owner.api.call(
      'PUT',
      `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}/secret`,
      { expectedSecretVersionId: connection.secretVersionId, credential },
      { 'idempotency-key': randomUUID() },
    );

  const revoke = (owner: Owner, connection: Connection) =>
    owner.api.call(
      'DELETE',
      `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}`,
    );

  const usedStep = (connection: Connection) =>
    ({
      connectionId: connection.id,
      method: 'GET',
      url: harness.apiUrl(),
    }) as const;

  // Roles table, S23: anyone who can read sees the settings, never the secret.
  it('S23 a viewer reads the settings, never the secret', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    const viewer = await harness.addMember(owner.workspaceId, 'viewer');
    const read = await harness.read(viewer.api, owner, connection.id);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({
      status: 'active',
      oauth2: {
        settings: {
          clientId: connection.clientId,
          tokenUrl: `${harness.standIn.origin}/token`,
          scope: 'read',
        },
      },
    });
    expect(JSON.stringify(read.json)).not.toContain(connection.clientSecret);
  });

  // Roles table: viewer can't test; builder and operator can; only managers change it.
  it('Roles a viewer can’t test or change it, and an editor can only test', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    const viewer = await harness.addMember(owner.workspaceId, 'viewer');
    const asViewer = { ...owner, api: viewer.api };
    expect((await harness.test(asViewer, connection.id, TEST_URL)).status).toBe(
      403,
    );
    expect(harness.standIn.apiCalls(connection.clientId)).toEqual([]);
    for (const role of ['builder', 'operator'] as const) {
      const member = await harness.addMember(owner.workspaceId, role);
      const asMember = { ...owner, api: member.api };
      expect(
        (await harness.test(asMember, connection.id, TEST_URL)).status,
        role,
      ).toBe(200);
      expect(
        (
          await replace(asMember, connection, {
            type: 'oauth2',
            settings: harness.settings(connection.clientId),
            clientSecret: connection.clientSecret,
          })
        ).status,
        role,
      ).toBe(403);
      expect((await revoke(asMember, connection)).status, role).toBe(403);
    }
    expect((await harness.connection(connection.id)).status).toBe('active');
  });

  // Proof list: a restricted connection honors sharing in a test and in a run.
  it('sharing: an unshared builder can neither test nor bind a restricted connection', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    const shared = await harness.addMember(owner.workspaceId, 'builder');
    const unshared = await harness.addMember(owner.workspaceId, 'builder');
    const sharing = await owner.api.call(
      'GET',
      `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}/sharing`,
    );
    const { revision } = sharing.json as { revision: number };
    const restricted = await owner.api.call(
      'POST',
      `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}/sharing`,
      {
        mode: 'restricted',
        expectedSharingRevision: revision,
        userIds: [shared.userId],
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(restricted.status).toBe(200);
    const callsBefore = harness.standIn.apiCalls(connection.clientId).length;
    const refused = await harness.test(
      { ...owner, api: unshared.api },
      connection.id,
      TEST_URL,
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(harness.standIn.apiCalls(connection.clientId).length).toBe(
      callsBefore,
    );
    const allowed = await harness.test(
      { ...owner, api: shared.api },
      connection.id,
      TEST_URL,
    );
    expect(allowed.status).toBe(200);
    // Publishing a new binding needs Use, exactly as for a header connection.
    await expect(
      harness.run({ ...owner, api: unshared.api }, usedStep(connection)),
    ).rejects.toThrow();
    const runId = await harness.run(
      { ...owner, api: shared.api },
      usedStep(connection),
    );
    expect((await harness.finish(runId)).status).toBe('succeeded');
  });

  // Test route table: not active: its code, no network, not "reauthorization required".
  it('test: not active answers its code with no network', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const tested = await harness.test(owner, connection.id, TEST_URL);
    expect(tested.status).toBe(200);
    expect(tested.json).toMatchObject({
      outcome: {
        ok: false,
        errorCode: 'connection.oauth2_not_authorized',
      },
    });
    expect(harness.standIn.tokenRequests(connection.clientId)).toEqual([]);
    expect(harness.standIn.apiCalls(connection.clientId)).toEqual([]);
  });

  // Test route table: host not allowed: no network.
  it('test: an unlisted host answers host_not_allowed with no network', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating', {
      requestHosts: { mode: 'listed', hosts: ['other.example.test'] },
    });
    const requestsBefore = harness.standIn.requests.length;
    const tested = await harness.test(owner, connection.id, TEST_URL);
    expect(tested.json).toMatchObject({
      outcome: { ok: false, errorCode: 'connection.oauth2_host_not_allowed' },
    });
    expect(harness.standIn.requests.length).toBe(requestsBefore);
    expect((await harness.connection(connection.id)).status).toBe('active');
  });

  // Test route table: temporary failures of the token address.
  it.each([
    ['503', 'connection.provider_unavailable'],
    ['429', 'connection.provider_rate_limited'],
  ])('test: a token address answering %s gives %s', async (behavior, code) => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    harness.standIn.setBehavior(connection.clientId, behavior);
    await harness.expireToken(connection.id);
    const tested = await harness.test(owner, connection.id, TEST_URL);
    expect(tested.json).toMatchObject({
      outcome: { ok: false, errorCode: code },
    });
    expect((await harness.connection(connection.id)).status).toBe('active');
  });

  // Test route table: unusable answers.
  it.each(['not-json', 'oversized', 'mac', 'teapot'])(
    'test: a token address answering %s is provider_invalid_response',
    async (behavior) => {
      const owner = await harness.newOwner();
      const connection = await harness.connected(owner, 'non-rotating');
      harness.standIn.setBehavior(connection.clientId, behavior);
      await harness.expireToken(connection.id);
      const tested = await harness.test(owner, connection.id, TEST_URL);
      expect(tested.json).toMatchObject({
        outcome: {
          ok: false,
          errorCode: 'connection.provider_invalid_response',
        },
      });
      expect((await harness.connection(connection.id)).status).toBe('active');
    },
  );

  // Test route table: invalid_*: the new code, and the status already changed.
  it.each([
    ['invalid-grant', 'connection.oauth2_grant_revoked'],
    ['invalid-client', 'connection.oauth2_client_rejected'],
  ])('test: a token address answering %s gives %s', async (behavior, code) => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    harness.standIn.setBehavior(connection.clientId, behavior);
    await harness.expireToken(connection.id);
    const tested = await harness.test(owner, connection.id, TEST_URL);
    expect(tested.json).toMatchObject({
      connection: { status: 'reauthorization_required' },
      outcome: { ok: false, errorCode: code },
    });
    expect(await harness.connection(connection.id)).toMatchObject({
      status: 'reauthorization_required',
      last_error_code: code,
    });
  });

  // L15, test route table: a 401 from the test URL leaves the status active.
  it.each(['api-401', 'api-403'])(
    'L15 test: an API answering %s is credential_rejected and leaves it active',
    async (behavior) => {
      const owner = await harness.newOwner();
      const connection = await harness.connected(owner, behavior);
      const tested = await harness.test(owner, connection.id, TEST_URL);
      expect(tested.json).toMatchObject({
        connection: { status: 'active' },
        outcome: { ok: false, errorCode: 'connection.credential_rejected' },
      });
      expect((await harness.connection(connection.id)).status).toBe('active');
      expect(await harness.tokenRow(connection.id)).toBeDefined();
    },
  );

  // Connection tests: "applies L11 once", so an old token rejected by 401 renews.
  it('test: a 401 on an old token renews once and repeats', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'api-401-once');
    await harness.ageToken(connection.id);
    const exchanged = harness.standIn.tokenRequests(connection.clientId).length;
    const tested = await harness.test(owner, connection.id, TEST_URL);
    expect(tested.json).toMatchObject({
      outcome: { ok: true, httpStatus: 200, errorCode: null },
    });
    expect(harness.standIn.apiCalls(connection.clientId)).toHaveLength(2);
    expect(harness.standIn.tokenRequests(connection.clientId)).toHaveLength(
      exchanged + 1,
    );
  });

  // Connection tests: an HTTPS URL only, same body as header connections.
  it('test: refuses plain http, as for every connection', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.connected(owner, 'non-rotating');
    const tested = await harness.test(
      owner,
      connection.id,
      'http://api.public.example.test/api',
    );
    expect(tested.status).toBe(400);
    expect(harness.standIn.apiCalls(connection.clientId)).toEqual([]);
  });
});
