import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeOAuth2,
  startOAuth2Harness,
  useOAuth2Timeouts,
  WEB_ORIGIN,
  type OAuth2Harness,
  type Owner,
} from '../support/oauth2/harness.js';

useOAuth2Timeouts();

const refusal = {
  code: 'connection.oauth2_endpoint_refused',
};

/** Refused whatever networks are set, or by S14's shape before S15 is even asked. */
const webHost = new URL(WEB_ORIGIN).hostname;

// S15 with HTTP_ALLOWED_PRIVATE_NETWORKS empty.
const REFUSED_WITH_NO_NETWORKS = [
  'http://id.example.com/o',
  'https://127.0.0.1/o',
  'https://10.0.0.5/o',
  'https://192.168.1.1/o',
  'https://169.254.169.254/latest/meta-data',
  'https://8.8.8.8/o',
  'https://[::1]/o',
  'https://[2606:4700:4700::1111]/o',
  'https://[::ffff:127.0.0.1]/o',
  'https://2130706433/o',
  'https://0x7f.0.0.1/o',
  'https://localhost/o',
  'https://LOCALHOST/o',
  'https://localhost./o',
  'https://a.localhost/o',
  'https://printer.local/o',
  'https://db.internal/o',
  'https://wiki.intranet/o',
  'https://nas.lan/o',
  'https://router.home.arpa/o',
  'https://intranet/o',
  'https://intranet./o',
  `https://${webHost}:5999/o`,
];

describeOAuth2('which addresses an OAuth2 connection may use', () => {
  describeOAuth2('with no private networks allowed', () => {
    let harness: OAuth2Harness;
    let owner: Owner;

    beforeAll(async () => {
      harness = await startOAuth2Harness('addresses-empty', {
        environment: { HTTP_ALLOWED_PRIVATE_NETWORKS: '' },
      });
      owner = await harness.newOwner();
    });
    afterAll(async () => {
      await harness.close();
    });

    // S15: each address, in each field, naming the field.
    it.each(REFUSED_WITH_NO_NETWORKS)(
      'S15 refuses %s as a token address',
      async (tokenUrl) => {
        const created = await harness.createResponse(
          owner,
          harness.settings('client', {
            authorizationUrl: 'https://id.example.com/authorize',
            tokenUrl,
          }),
        );
        expect(created.status).toBe(400);
        expect(created.json).toMatchObject(refusal);
        expect(JSON.stringify(created.json)).toContain('tokenUrl');
      },
    );

    it.each(REFUSED_WITH_NO_NETWORKS)(
      'S15 refuses %s as an authorization address',
      async (authorizationUrl) => {
        const created = await harness.createResponse(
          owner,
          harness.settings('client', {
            authorizationUrl,
            tokenUrl: 'https://id.example.com/token',
          }),
        );
        expect(created.status).toBe(400);
        expect(created.json).toMatchObject(refusal);
        expect(JSON.stringify(created.json)).toContain('authorizationUrl');
      },
    );

    // S15: a public name over https is what the rule leaves.
    it('S15 accepts https on a public name', async () => {
      const created = await harness.createResponse(
        owner,
        harness.settings('client', {
          authorizationUrl: 'https://id.example.com/authorize',
          tokenUrl: 'https://id.example.com/token',
        }),
      );
      expect(created.status).toBe(201);
      expect(created.json).toMatchObject({
        authType: 'oauth2',
        status: 'reauthorization_required',
        health: { lastErrorCode: 'connection.oauth2_not_authorized' },
      });
    });

    // S15: replace is also one of the three places the address rule runs.
    it('S15 refuses a bad address on replace too', async () => {
      const created = await harness.createResponse(
        owner,
        harness.settings('client', {
          authorizationUrl: 'https://id.example.com/authorize',
          tokenUrl: 'https://id.example.com/token',
        }),
      );
      const { id, secretVersionId } = created.json as {
        id: string;
        secretVersionId: string;
      };
      const replaced = await owner.api.call(
        'PUT',
        `/v1/workspaces/${owner.workspaceId}/connections/${id}/secret`,
        {
          expectedSecretVersionId: secretVersionId,
          credential: {
            type: 'oauth2',
            settings: harness.settings('client', {
              authorizationUrl: 'https://id.example.com/authorize',
              tokenUrl: 'https://169.254.169.254/token',
            }),
            clientSecret: 'a-secret',
          },
        },
        { 'idempotency-key': crypto.randomUUID() },
      );
      expect(replaced.status).toBe(400);
      expect(replaced.json).toMatchObject(refusal);
    });
  });

  describeOAuth2('with a private network allowed', () => {
    let harness: OAuth2Harness;
    let owner: Owner;

    beforeAll(async () => {
      harness = await startOAuth2Harness('addresses-set');
      owner = await harness.newOwner();
    });
    afterAll(async () => {
      await harness.close();
    });

    const tokenAddress = (tokenUrl: string) =>
      harness.createResponse(owner, harness.settings('client', { tokenUrl }));

    // S15: an IP literal passes only inside the networks.
    it.each(['http://127.0.0.1:9/token', 'https://127.0.0.1:9/token'])(
      'S15 accepts %s inside the allowed network',
      async (tokenUrl) => {
        expect((await tokenAddress(tokenUrl)).status).toBe(201);
      },
    );

    it.each([
      'http://127.0.0.2/token',
      'https://10.0.0.5/token',
      'https://169.254.169.254/latest/meta-data',
      'https://8.8.8.8/token',
      'https://[::1]/token',
    ])('S15 refuses %s outside the allowed network', async (tokenUrl) => {
      const created = await tokenAddress(tokenUrl);
      expect(created.status).toBe(400);
      expect(created.json).toMatchObject(refusal);
    });

    // S15: "names are settled at dispatch", so the local-looking names now pass.
    it.each([
      'http://id.example.com/token',
      'https://other.localhost/token',
      'https://printer.local/token',
      'https://db.internal/token',
      'https://wiki.intranet/token',
      'https://nas.lan/token',
      'https://router.home.arpa/token',
      'https://intranet/token',
    ])('S15 leaves the name in %s for dispatch', async (tokenUrl) => {
      expect((await tokenAddress(tokenUrl)).status).toBe(201);
    });

    // S6 (review): the authorization address is never dispatched, so nothing would
    // ever refuse it, and consent would start in cleartext to a public name.
    it('S6 refuses plain http to a public name as an authorization address', async () => {
      const created = await harness.createResponse(
        owner,
        harness.settings('client', {
          authorizationUrl: 'http://id.example.com/authorize',
        }),
      );
      expect(created.status).toBe(400);
      expect(created.json).toMatchObject(refusal);
      expect(JSON.stringify(created.json)).toContain('authorizationUrl');
    });

    // S6: a local name stays allowed, as the review's fix says.
    it.each([
      'http://127.0.0.1:9/authorize',
      'http://printer.local/authorize',
      'http://intranet/authorize',
    ])(
      'S6 still takes %s as an authorization address',
      async (authorizationUrl) => {
        const created = await harness.createResponse(
          owner,
          harness.settings('client', { authorizationUrl }),
        );
        expect(created.status).toBe(201);
      },
    );

    // S6: otherwise the token address fails only after a code is spent, and the
    // landing blames the service.
    it('S6 checks a token address that resolves to plain http on a public address at start', async () => {
      const scene = await harness.newOwner();
      const connection = await harness.create(scene, 'non-rotating', {
        tokenUrl: 'http://public.example.test/token',
      });
      const started = await harness.start(scene.api, scene, connection.id);
      expect(started.status).toBeGreaterThanOrEqual(400);
      expect(started.json).not.toHaveProperty('authorizationUrl');
      expect(await harness.pendingRows(connection.id)).toBe(0);
    });

    // S15: always refused, networks or not.
    it.each([
      `http://${webHost}/token`,
      `http://${webHost}:5999/token`,
      `https://${webHost}/token`,
    ])('S15 always refuses the web host: %s', async (tokenUrl) => {
      const created = await tokenAddress(tokenUrl);
      expect(created.status).toBe(400);
      expect(created.json).toMatchObject(refusal);
    });

    const leaks = () =>
      harness.standIn.requests.filter(({ path }) => path.startsWith('/leak'));

    // S17: every dispatch re-resolves and rechecks, for each kind of bad answer.
    it.each([
      'http://private.example.test/token',
      'http://metadata.example.test/token',
      'http://public.example.test/token',
    ])('S17 a step never sends a refresh to %s', async (tokenUrl) => {
      const scene = await harness.newOwner();
      const connection = await harness.connected(scene, 'non-rotating');
      await harness.setTokenUrl(connection.id, tokenUrl);
      await harness.expireToken(connection.id);
      const before = leaks().length;
      const runId = await harness.run(scene, {
        connectionId: connection.id,
        method: 'GET',
        url: harness.apiUrl(),
      });
      expect((await harness.finish(runId)).status).toBe('failed');
      const [attempt] = await harness.attempts(runId);
      expect(attempt).toMatchObject({
        safe_error_code: 'http.oauth2_token_address_blocked',
        error_summary: 'The token URL points to a private or blocked address.',
        executor_failure_kind: 'failed',
        executor_error_kind: 'configuration',
        executor_possibly_dispatched: false,
      });
      expect(leaks().length).toBe(before);
      expect(harness.standIn.apiCalls(connection.clientId)).toEqual([]);
      // The answer table: "Unchanged".
      expect((await harness.connection(connection.id)).status).toBe('active');
    });

    // S17: the API's own token requests go through the same policy.
    it('S17 the API never sends a code exchange to a name that resolves privately', async () => {
      const scene = await harness.newOwner();
      const connection = await harness.create(scene, 'non-rotating');
      const url = harness.authorizationUrl(
        await harness.start(scene.api, scene, connection.id),
      );
      const callbackUrl = await harness.decide(url, 'approve');
      await harness.setTokenUrl(
        connection.id,
        'http://metadata.example.test/token',
      );
      const before = leaks().length;
      const landing = await harness.land(scene.api, callbackUrl);
      expect(landing.result).not.toBe('connected');
      expect(leaks().length).toBe(before);
      expect(await harness.tokenRow(connection.id)).toBeUndefined();
    });

    // S17: same for a server-to-server start.
    it('S17 a client-credentials start can’t reach a private name', async () => {
      const scene = await harness.newOwner();
      const connection = await harness.createServer(scene, 'non-rotating', {
        tokenUrl: 'http://private.example.test/token',
      });
      const before = leaks().length;
      const started = await harness.start(scene.api, scene, connection.id);
      expect(started.status).not.toBe(200);
      expect(leaks().length).toBe(before);
      expect(await harness.tokenRow(connection.id)).toBeUndefined();
    });

    // S16: only the person's browser requests the authorization address.
    it('S16 the server never requests the authorization address', async () => {
      const scene = await harness.newOwner();
      const connection = await harness.create(scene, 'non-rotating');
      const url = harness.authorizationUrl(
        await harness.start(scene.api, scene, connection.id),
      );
      expect(harness.standIn.authorizeRequests(connection.clientId)).toEqual(
        [],
      );
      await harness.land(scene.api, await harness.decide(url, 'approve'));
      // The one request is this test's own browser, from decide above.
      expect(
        harness.standIn.authorizeRequests(connection.clientId),
      ).toHaveLength(1);
    });

    // S18: a redirect from the token address fails, with the secret sent nowhere else.
    it.each(['redirect', 'redirect-307'])(
      'S18 a token %s fails and the secret never follows it',
      async (behavior) => {
        const scene = await harness.newOwner();
        const connection = await harness.connected(scene, 'non-rotating');
        harness.standIn.setBehavior(connection.clientId, behavior);
        await harness.expireToken(connection.id);
        const before = harness.standIn.redirectTargetRequests().length;
        const runId = await harness.run(scene, {
          connectionId: connection.id,
          method: 'GET',
          url: harness.apiUrl(),
          retry: { maximumAttempts: 1, delayMillis: 1_000 },
        });
        await harness.finish(runId);
        const [attempt] = await harness.attempts(runId);
        expect(attempt?.safe_error_code).toBe(
          'http.oauth2_token_response_invalid',
        );
        expect(harness.standIn.redirectTargetRequests().length).toBe(before);
      },
    );
  });

  describeOAuth2('with a worker that has no private networks', () => {
    let harness: OAuth2Harness;

    beforeAll(async () => {
      harness = await startOAuth2Harness('addresses-worker-empty', {
        workerEnvironment: { HTTP_ALLOWED_PRIVATE_NETWORKS: '' },
      });
    });
    afterAll(async () => {
      await harness.close();
    });

    // S17: "the transport only refuses plain http to a public address when a policy exists".
    it('S17 plain http to a public address is refused even with no networks set', async () => {
      const owner = await harness.newOwner();
      const connection = await harness.connected(owner, 'non-rotating');
      await harness.setTokenUrl(
        connection.id,
        'http://public.example.test/token',
      );
      await harness.expireToken(connection.id);
      const runId = await harness.run(owner, {
        connectionId: connection.id,
        method: 'GET',
        url: 'https://api.public.example.test/api',
      });
      expect((await harness.finish(runId)).status).toBe('failed');
      const [attempt] = await harness.attempts(runId);
      expect(attempt?.safe_error_code).toBe(
        'http.oauth2_token_address_blocked',
      );
      expect(
        harness.standIn.requests.filter(({ path }) => path.startsWith('/leak')),
      ).toEqual([]);
    });
  });
});
