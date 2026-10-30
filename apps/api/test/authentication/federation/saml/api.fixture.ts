import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { federationSettingsSchema } from '@pertexo/contracts';
import {
  useBetterAuthRealApi,
  setCookie,
  type Browser,
} from '../../../support/better-auth/real-api.support.js';
import {
  parseXml,
  root,
  onlyChild,
  plainText,
  SAML_PROTOCOL,
  SAML_ASSERTION,
} from '../../../../src/authentication/federation/protocol/saml/xml.js';
import {
  signedResponse,
  signingMaterial,
  type ResponseOptions,
  type SigningMaterial,
} from './fixture.js';

export const samlOrigin = 'https://app.integration.test';
export const encryption = {
  current: {
    version: 'saml-v1',
    key: Buffer.alloc(32, 0x51).toString('base64'),
  },
  previous: [],
};
export function useSamlApi(
  suite: string,
  options: Pick<
    NonNullable<Parameters<typeof useBetterAuthRealApi>[1]>,
    'signUpMode'
  > = {},
) {
  let material: SigningMaterial;
  beforeAll(() => {
    material = signingMaterial();
  });
  const api = useBetterAuthRealApi(suite, {
    ...options,
    publicWebOrigin: samlOrigin,
    secureCookies: true,
    federationEncryption: encryption,
    databasePoolMax: 1,
  });
  let restoreDns: (() => void) | undefined;
  beforeAll(() => {
    const dns = vi
      .spyOn(Resolver.prototype, 'resolveTxt')
      .mockImplementation(async (hostname) => {
        const rows = await api
          .database()
          .query<{ challenge: string }>(
            'select challenge from app.auth_domains where domain=$1 and challenge is not null',
            [hostname.replace(/^_pertexo\./u, '')],
          );
        return rows.rows.map((row) => [
          `pertexo-verification=${row.challenge}`,
        ]);
      });
    restoreDns = () => {
      dns.mockRestore();
    };
  });
  afterAll(() => {
    restoreDns?.();
  });
  async function command({
    workspaceId,
    owner,
    path,
    payload,
    method = 'POST',
    key = randomUUID(),
  }: Readonly<{
    workspaceId: string;
    owner: Browser;
    path: string;
    payload: object;
    method?: 'POST' | 'PUT' | undefined;
    key?: `${string}-${string}-${string}-${string}-${string}` | undefined;
  }>) {
    const response = await api.send(
      method,
      `/v1/workspaces/${workspaceId}/sso${path}`,
      { browser: owner, payload, headers: { 'idempotency-key': key } },
    );
    expect(response.statusCode, response.payload).toBe(200);
    return federationSettingsSchema.parse(response.json());
  }
  async function setup(enabled = true) {
    const domain = `${randomUUID()}.example.test`,
      ownerEmail = `owner@${domain}`;
    await api.signUp(ownerEmail, '/workspaces');
    const owner = await api.signIn(ownerEmail);
    const workspace = await api.send('POST', '/v1/workspaces', {
      browser: owner,
      payload: { name: 'SAML organization', slug: `saml-${randomUUID()}` },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(workspace.statusCode, workspace.payload).toBe(201);
    const workspaceId = workspace.json<{ id: string }>().id;
    await command({
      workspaceId: workspaceId,
      owner: owner,
      path: '/organization',
      payload: {
        name: 'SAML organization',
      },
    });
    const added = await command({
      workspaceId: workspaceId,
      owner: owner,
      path: '/domains',
      payload: {
        domain,
        expectedRevision: 1,
      },
    });
    const domainId = added.organization?.domains[0]?.id;
    if (domainId === undefined) throw new Error('Domain missing');
    await command({
      workspaceId: workspaceId,
      owner: owner,
      path: `/domains/${domainId}/verify`,
      payload: {
        expectedRevision: 2,
      },
    });
    const settings = await command({
      workspaceId: workspaceId,
      owner: owner,
      path: '/providers',
      payload: {
        kind: 'saml',
        name: 'Owned SAML',
        issuer: 'http://www.okta.com/owned-idp',
        configuration: {
          signInUrl: 'https://idp.example.test/sso',
          certificates: [material.certificate],
          emailAttribute: 'email',
          nameAttribute: 'name',
          jitEnabled: true,
        },
        enabled,
        expectedRevision: 3,
      },
    });
    const organization = settings.organization;
    if (organization === null) throw new Error('Organization missing');
    const provider = organization.providers[0];
    if (provider?.kind !== 'saml') throw new Error('SAML provider missing');
    return {
      organizationId: organization.id,
      workspaceId,
      owner,
      ownerEmail,
      domainId,
      domain,
      provider,
      settings,
    };
  }
  async function start(
    fixture: Awaited<ReturnType<typeof setup>>,
    testing = false,
  ) {
    const response = await api.send(
      'POST',
      `/v1/auth/federation/saml/${testing ? 'test' : 'start'}`,
      {
        ...(testing ? { browser: fixture.owner } : {}),
        payload: testing
          ? {
              workspaceId: fixture.workspaceId,
              domainId: fixture.domainId,
              providerId: fixture.provider.id,
            }
          : {
              domain: fixture.domain,
              providerId: fixture.provider.id,
              returnPath: '/account/security',
            },
      },
    );
    expect(response.statusCode, response.payload).toBe(200);
    const url = new URL(
      response.json<{ authorizationUrl: string }>().authorizationUrl,
    );
    const request = root(
      parseXml(
        inflateRawSync(
          Buffer.from(url.searchParams.get('SAMLRequest') ?? '', 'base64'),
          { maxOutputLength: 16384 },
        ).toString(),
      ),
      SAML_PROTOCOL,
      'AuthnRequest',
    );
    const proof = {
      state: url.searchParams.get('RelayState') ?? '',
      requestId: request.getAttribute('ID') ?? '',
      entityId: plainText(onlyChild(request, SAML_ASSERTION, 'Issuer')),
      redirectUri: request.getAttribute('AssertionConsumerServiceURL') ?? '',
      createdAt: new Date(),
    };
    return {
      proof,
      cookie: `__Host-pertexo_organization_saml=${setCookie(response, '__Host-pertexo_organization_saml')}`,
      response,
    };
  }
  function form(
    fixture: Awaited<ReturnType<typeof setup>>,
    journey: Awaited<ReturnType<typeof start>>,
    options: ResponseOptions = {},
  ) {
    return new URLSearchParams({
      RelayState: journey.proof.state,
      SAMLResponse: signedResponse(material, fixture.provider, journey.proof, {
        email: `person@${fixture.domain}`,
        ...options,
      }),
    }).toString();
  }
  function finish(
    fixture: Awaited<ReturnType<typeof setup>>,
    journey: Awaited<ReturnType<typeof start>>,
    options: ResponseOptions = {},
    cookie = journey.cookie,
  ) {
    return api.send('POST', '/v1/auth/federation/saml/callback', {
      headers: {
        cookie,
        origin: 'https://idp.example.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: form(fixture, journey, options),
    });
  }
  return { ...api, setup, start, finish, form, command, encryption };
}
