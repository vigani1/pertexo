import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CALLBACK_PATH,
  describeOAuth2,
  LANDING_PATH,
  startOAuth2Harness,
  useOAuth2Timeouts,
  WEB_ORIGIN,
  type Connection,
  type OAuth2Harness,
  type Owner,
} from '../../support/oauth2/harness.js';

useOAuth2Timeouts();

/** What every refused callback answers: nothing that names a connection. */
const INVALID_LANDING = `${WEB_ORIGIN}${LANDING_PATH}?result=invalid`;

describeOAuth2('returning from OAuth2 consent', () => {
  let harness: OAuth2Harness;

  beforeAll(async () => {
    harness = await startOAuth2Harness('consent-callback');
  });
  afterAll(async () => {
    await harness.close();
  });

  /** A connection whose consent is pending, and the address the service would send back. */
  const pendingConsent = async (
    behavior = 'non-rotating',
  ): Promise<
    Readonly<{ owner: Owner; connection: Connection; callbackUrl: string }>
  > => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, behavior);
    const started = await harness.start(owner.api, owner, connection.id);
    const callbackUrl = await harness.decide(
      harness.authorizationUrl(started),
      'approve',
    );
    return { owner, connection, callbackUrl };
  };

  const stateOf = (url: string): string =>
    new URL(url).searchParams.get('state') ?? '';

  const expectNothingExchanged = (connection: Connection): void => {
    expect(harness.standIn.tokenRequests(connection.clientId)).toEqual([]);
  };

  // Landing: connected names its connection, and it becomes active.
  it('an approved consent connects and names the connection', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    const landing = await harness.land(owner.api, callbackUrl);
    expect(landing.status).toBe(303);
    expect(landing).toMatchObject({
      result: 'connected',
      workspaceId: owner.workspaceId,
      connectionId: connection.id,
    });
    expect(landing.location?.startsWith(`${WEB_ORIGIN}${LANDING_PATH}?`)).toBe(
      true,
    );
    expect((await harness.connection(connection.id)).status).toBe('active');
    expect(await harness.pendingRows(connection.id)).toBe(0);
  });

  // S5: the session stays home on a cross-site return; only the binding cookie comes.
  it('S5 needs no session on the way back', async () => {
    const { owner, callbackUrl } = await pendingConsent();
    const landing = await harness.land(owner.api, callbackUrl, (name) =>
      name.startsWith('pertexo_oauth2_'),
    );
    expect(landing.result).toBe('connected');
  });

  // S5, proof list: a callback with no cookie exchanges nothing and leaves the row.
  it('no cookie: invalid, nothing exchanged, row kept for the right browser', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    const landing = await harness.land(owner.api, callbackUrl, () => false);
    expect(landing.status).toBe(303);
    expect(landing.location).toBe(INVALID_LANDING);
    expectNothingExchanged(connection);
    expect(await harness.pendingRows(connection.id)).toBe(1);
    expect((await harness.land(owner.api, callbackUrl)).result).toBe(
      'connected',
    );
  });

  // S5, proof list: "wrong cookie (and the row survives for the right browser)".
  it('wrong cookie: invalid, nothing exchanged, the right browser still works', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    const name = `pertexo_oauth2_${connection.id.replaceAll('-', '')}`;
    const value = owner.api.cookieValue(name);
    expect(value).toBeDefined();
    owner.api.setCookie(name, 'B'.repeat(43));
    expect((await harness.land(owner.api, callbackUrl)).location).toBe(
      INVALID_LANDING,
    );
    expectNothingExchanged(connection);
    expect(await harness.pendingRows(connection.id)).toBe(1);
    owner.api.setCookie(name, value ?? '');
    expect((await harness.land(owner.api, callbackUrl)).result).toBe(
      'connected',
    );
  });

  // S5: "That is what refuses a link sent to someone else."
  it('a link sent to someone else’s browser is refused', async () => {
    const { connection, callbackUrl, owner } = await pendingConsent();
    const stranger = harness.anonymousBrowser();
    expect((await harness.land(stranger, callbackUrl)).location).toBe(
      INVALID_LANDING,
    );
    const member = await harness.addMember(owner.workspaceId, 'admin');
    expect((await harness.land(member.api, callbackUrl)).location).toBe(
      INVALID_LANDING,
    );
    expectNothingExchanged(connection);
    expect(await harness.pendingRows(connection.id)).toBe(1);
  });

  // S7: the workspace in the state selects row security; changing it matches no row.
  it('a tampered workspace in the state lands invalid', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    const other = await harness.newOwner();
    const url = new URL(callbackUrl);
    const secret = stateOf(callbackUrl).split('.')[1] ?? '';
    const otherWorkspace = Buffer.from(
      other.workspaceId.replaceAll('-', ''),
      'hex',
    ).toString('base64url');
    url.searchParams.set('state', `${otherWorkspace}.${secret}`);
    expect((await harness.land(owner.api, url.toString())).location).toBe(
      INVALID_LANDING,
    );
    expectNothingExchanged(connection);
    expect(await harness.pendingRows(connection.id)).toBe(1);
  });

  // S4: a state works once.
  it('a replayed callback lands invalid and exchanges nothing more', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    const name = `pertexo_oauth2_${connection.id.replaceAll('-', '')}`;
    const value = owner.api.cookieValue(name) ?? '';
    expect((await harness.land(owner.api, callbackUrl)).result).toBe(
      'connected',
    );
    owner.api.setCookie(name, value);
    expect((await harness.land(owner.api, callbackUrl)).location).toBe(
      INVALID_LANDING,
    );
    expect(harness.standIn.tokenRequests(connection.clientId)).toHaveLength(1);
  });

  // S4: two concurrent callbacks exchange one code.
  it('two callbacks at once exchange one code', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    const hold = harness.standIn.holdNextToken(connection.clientId);
    const landings = Promise.all([
      harness.land(owner.api, callbackUrl),
      harness.land(owner.api, callbackUrl),
    ]);
    await hold.arrived;
    hold.release();
    const results = (await landings).map(({ result }) => result).sort();
    expect(results).toEqual(['connected', 'invalid']);
    expect(harness.standIn.tokenRequests(connection.clientId)).toHaveLength(1);
  });

  // S3: state expires 600 s after start, by database time.
  it('an expired state lands invalid', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    await harness.stack.sql(
      `update app.connection_oauth2_authorizations
          set expires_at = clock_timestamp() - interval '1 second'
        where connection_id=$1`,
      [connection.id],
    );
    expect((await harness.land(owner.api, callbackUrl)).location).toBe(
      INVALID_LANDING,
    );
    expectNothingExchanged(connection);
  });

  // S2: a new start replaces the old one, so the older state stops working.
  it('a newer start replaces the older one', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    const newer = harness.authorizationUrl(
      await harness.start(owner.api, owner, connection.id),
    );
    expect(await harness.pendingRows(connection.id)).toBe(1);
    const landed = await harness.land(owner.api, callbackUrl);
    expect(landed.location).toBe(INVALID_LANDING);
    expectNothingExchanged(connection);
    expect(
      (await harness.land(owner.api, await harness.decide(newer, 'approve')))
        .result,
    ).toBe('connected');
  });

  // S6: the starter must still have connection:manage; a demoted one gets nothing.
  it('a starter demoted mid-consent lands invalid', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const admin = await harness.addMember(owner.workspaceId, 'admin');
    const url = harness.authorizationUrl(
      await harness.start(admin.api, owner, connection.id),
    );
    const callbackUrl = await harness.decide(url, 'approve');
    await harness.stack.sql(
      `update app.workspace_memberships set role='viewer', role_revision=role_revision+1
        where workspace_id=$1 and user_id=$2`,
      [owner.workspaceId, admin.userId],
    );
    expect((await harness.land(admin.api, callbackUrl)).location).toBe(
      INVALID_LANDING,
    );
    expectNothingExchanged(connection);
  });

  // S6: and neither does one removed from the workspace.
  it('a starter removed mid-consent lands invalid', async () => {
    const owner = await harness.newOwner();
    const connection = await harness.create(owner, 'non-rotating');
    const admin = await harness.addMember(owner.workspaceId, 'admin');
    const url = harness.authorizationUrl(
      await harness.start(admin.api, owner, connection.id),
    );
    const callbackUrl = await harness.decide(url, 'approve');
    await harness.stack.sql(
      `update app.workspace_memberships set status='removed'
        where workspace_id=$1 and user_id=$2`,
      [owner.workspaceId, admin.userId],
    );
    expect((await harness.land(admin.api, callbackUrl)).location).toBe(
      INVALID_LANDING,
    );
    expectNothingExchanged(connection);
  });

  // S8: a connection revoked mid-consent.
  it('a connection revoked mid-consent lands invalid', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    const revoked = await owner.api.call(
      'DELETE',
      `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}`,
    );
    expect(revoked.status).toBeLessThan(300);
    expect((await harness.land(owner.api, callbackUrl)).location).toBe(
      INVALID_LANDING,
    );
    expectNothingExchanged(connection);
    expect((await harness.connection(connection.id)).status).toBe('revoked');
  });

  // S8: settings replaced mid-consent.
  it('settings replaced mid-consent land invalid', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    const replaced = await owner.api.call(
      'PUT',
      `/v1/workspaces/${owner.workspaceId}/connections/${connection.id}/secret`,
      {
        expectedSecretVersionId: connection.secretVersionId,
        credential: {
          type: 'oauth2',
          settings: harness.settings(connection.clientId),
          clientSecret: connection.clientSecret,
        },
      },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(replaced.status).toBe(200);
    expect((await harness.land(owner.api, callbackUrl)).location).toBe(
      INVALID_LANDING,
    );
    expectNothingExchanged(connection);
  });

  // S7: all refusals look the same, down to malformed input.
  it.each([
    ['no parameters at all', ''],
    ['a state of the wrong shape', '?state=short&code=the-code'],
    ['no code and no error', `?state=${'A'.repeat(22)}.${'b'.repeat(43)}`],
    [
      'both a code and an error',
      `?state=${'A'.repeat(22)}.${'b'.repeat(43)}&code=x&error=y`,
    ],
    [
      'a repeated code',
      `?state=${'A'.repeat(22)}.${'b'.repeat(43)}&code=x&code=y`,
    ],
    [
      'a state nobody issued',
      `?state=${'A'.repeat(22)}.${'b'.repeat(43)}&code=x`,
    ],
  ])('S7 %s lands invalid', async (_name, query) => {
    const browser = harness.anonymousBrowser();
    const answer = await browser.navigate(
      `${CALLBACK_PATH}${query}`,
      () => true,
    );
    expect(answer.status).toBe(303);
    expect(answer.location).toBe(INVALID_LANDING);
    expect(answer.headers.get('cache-control')).toContain('no-store');
    expect(answer.headers.get('referrer-policy')).toBe('no-referrer');
  });

  // S11: every callback answer, and the cookie cleared once the row is consumed.
  it('S11 forbids caching and referrers, and clears the cookie when consumed', async () => {
    const { owner, connection, callbackUrl } = await pendingConsent();
    const name = `pertexo_oauth2_${connection.id.replaceAll('-', '')}`;
    const refused = await harness.land(owner.api, callbackUrl, () => false);
    expect(refused.headers.get('cache-control')).toContain('no-store');
    expect(refused.headers.get('referrer-policy')).toBe('no-referrer');
    expect(
      refused.headers
        .getSetCookie()
        .some((line) => line.startsWith(`${name}=`)),
      'a refusal leaves the right browser’s cookie alone',
    ).toBe(false);
    const landed = await harness.land(owner.api, callbackUrl);
    expect(landed.result).toBe('connected');
    expect(landed.headers.get('cache-control')).toContain('no-store');
    expect(landed.headers.get('referrer-policy')).toBe('no-referrer');
    const cleared = landed.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${name}=`));
    expect(cleared).toMatch(/max-age=0/iu);
    expect(owner.api.cookieValue(name)).toBeUndefined();
  });
});
