import type { OrganizationIdentity } from '../../../../src/authentication/federation/protocol/identity.js';
import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { beforeAll, afterAll, expect, vi } from 'vitest';
import { federationSettingsSchema } from '@pertexo/contracts';
import * as protocol from '../../../../src/authentication/federation/protocol/oidc.js';
import {
  useBetterAuthRealApi,
  setCookie,
  type Browser,
} from '../../../support/better-auth/real-api.support.js';

export const encryption = {
  current: {
    version: 'organization-v1',
    key: Buffer.alloc(32, 0x57).toString('base64'),
  },
  previous: [],
};
export function useOrganizationApi(suite: string) {
  const authorizations = new Map<string, protocol.OidcProof>();
  const identities = new Map<string, OrganizationIdentity>();
  const gateway: protocol.OidcProofGateway = {
    authorize: (_provider, proof) => {
      authorizations.set(proof.state, proof);
      return Promise.resolve(
        `https://idp.integration.test/authorize?state=${proof.state}`,
      );
    },
    verify: (_provider, proof, callback) => {
      const identity = identities.get(proof.state),
        expected = authorizations.get(proof.state);
      if (
        identity === undefined ||
        expected === undefined ||
        JSON.stringify(expected) !== JSON.stringify(proof) ||
        callback.searchParams.get('code') !== proof.state
      )
        return Promise.reject(new Error('Invalid provider proof'));
      return Promise.resolve(identity);
    },
  };
  let restoreGateway: (() => void) | undefined;
  let restoreDns: (() => void) | undefined;
  beforeAll(() => {
    const spy = vi
      .spyOn(protocol, 'createOidcProofGateway')
      .mockReturnValue(gateway);
    restoreGateway = () => {
      spy.mockRestore();
    };
  });
  const api = useBetterAuthRealApi(suite, {
    federationEncryption: encryption,
    databasePoolMax: 1,
  });
  beforeAll(() => {
    const spy = vi
      .spyOn(Resolver.prototype, 'resolveTxt')
      .mockImplementation(async (hostname) => {
        const result = await api
          .database()
          .query<{ challenge: string }>(
            'select challenge from app.auth_domains where domain=$1 and challenge is not null',
            [hostname.replace(/^_pertexo\./u, '')],
          );
        return result.rows.map((row) => [
          `pertexo-verification=${row.challenge}`,
        ]);
      });
    restoreDns = () => {
      spy.mockRestore();
    };
  });
  afterAll(() => {
    restoreDns?.();
    restoreGateway?.();
  });
  async function command(
    workspaceId: string,
    browser: Browser,
    path: string,
    payload: object,
    method: 'POST' | 'PUT' = 'POST',
    key = randomUUID(),
  ) {
    const reply = await api.send(
      method,
      `/v1/workspaces/${workspaceId}/sso${path}`,
      { browser, payload, headers: { 'idempotency-key': key } },
    );
    expect(reply.statusCode, reply.payload).toBe(200);
    return federationSettingsSchema.parse(reply.json());
  }
  async function setup(ownerInDomain = false) {
    const domain = `${randomUUID()}.example.test`,
      ownerEmail = `owner@${ownerInDomain ? domain : `${randomUUID()}.owner.test`}`;
    await api.signUp(ownerEmail, '/workspaces');
    const owner = await api.signIn(ownerEmail);
    const created = await api.send('POST', '/v1/workspaces', {
      browser: owner,
      payload: { name: 'Organization workspace', slug: `org-${randomUUID()}` },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(created.statusCode, created.payload).toBe(201);
    const value: unknown = created.json();
    if (
      typeof value !== 'object' ||
      value === null ||
      !('id' in value) ||
      typeof value.id !== 'string'
    )
      throw new Error('Workspace missing');
    const workspaceId = value.id;
    await command(workspaceId, owner, '/organization', {
      name: 'Fixture organization',
    });
    const added = await command(workspaceId, owner, '/domains', {
      domain,
      expectedRevision: 1,
    });
    const domainId = added.organization?.domains[0]?.id;
    if (domainId === undefined) throw new Error('Domain missing');
    await command(workspaceId, owner, `/domains/${domainId}/verify`, {
      expectedRevision: 2,
    });
    const settings = await command(workspaceId, owner, '/providers', {
      kind: 'oidc',
      name: 'Fixture OIDC',
      issuer: 'https://idp.integration.test',
      configuration: { clientId: 'fixture-client', jitEnabled: true },
      clientSecret: 'private-provider-secret',
      enabled: true,
      expectedRevision: 3,
    });
    const providerId = settings.organization?.providers[0]?.id;
    if (providerId === undefined) throw new Error('Provider missing');
    return {
      workspaceId,
      domain,
      domainId,
      providerId,
      owner,
      ownerEmail,
      settings,
    };
  }
  async function start(
    input: { providerId: string; domain: string },
    identity: OrganizationIdentity,
    testing?: { workspaceId: string; domainId: string; owner: Browser },
  ) {
    const reply = await api.send(
      'POST',
      `/v1/auth/federation/oidc/${testing === undefined ? 'start' : 'test'}`,
      {
        ...(testing === undefined ? {} : { browser: testing.owner }),
        payload:
          testing === undefined
            ? {
                providerId: input.providerId,
                domain: input.domain,
                returnPath: '/account/security',
              }
            : {
                workspaceId: testing.workspaceId,
                domainId: testing.domainId,
                providerId: input.providerId,
              },
      },
    );
    expect(reply.statusCode, reply.payload).toBe(200);
    const value: unknown = reply.json();
    if (
      typeof value !== 'object' ||
      value === null ||
      !('authorizationUrl' in value) ||
      typeof value.authorizationUrl !== 'string'
    )
      throw new Error('Authorization missing');
    const state = new URL(value.authorizationUrl).searchParams.get('state');
    if (state === null) throw new Error('State missing');
    identities.set(state, identity);
    const proof = authorizations.get(state);
    if (proof === undefined) throw new Error('Proof missing');
    const callback = new URL(proof.redirectUri);
    callback.searchParams.set('state', state);
    callback.searchParams.set('code', state);
    const binding = `pertexo_organization_signin=${setCookie(reply, 'pertexo_organization_signin')}`;
    return {
      state,
      callback: callback.pathname + callback.search,
      cookie:
        testing === undefined ? binding : `${testing.owner.cookie}; ${binding}`,
    };
  }
  const finish = (
    journey: Awaited<ReturnType<typeof start>>,
    cookie = journey.cookie,
  ) => api.send('GET', journey.callback, { headers: { cookie } });
  const person = (email: string): OrganizationIdentity => ({
    email,
    subject: randomUUID(),
    displayName: 'Organization Person',
  });
  async function ready(fixture: Awaited<ReturnType<typeof setup>>) {
    const journey = await start(fixture, person(`tester@${fixture.domain}`), {
      ...fixture,
      owner: fixture.owner,
    });
    const reply = await finish(journey);
    expect(reply.headers.location).toContain('ssoTest=passed');
    return reply;
  }
  async function enforce(
    fixture: Awaited<ReturnType<typeof setup>>,
    required = true,
    expectedRevision = 4,
  ) {
    return command(
      fixture.workspaceId,
      fixture.owner,
      `/domains/${fixture.domainId}/enforcement`,
      { required, expectedRevision },
      'PUT',
    );
  }
  return {
    ...api,
    command,
    setup,
    start,
    finish,
    person,
    ready,
    enforce,
    gateway,
  };
}
