import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';
import { directoryCredentialResultSchema } from '@pertexo/contracts';

import { useOrganizationApi } from '../../organization/fixture.js';

const coreUser = 'urn:ietf:params:scim:schemas:core:2.0:User';

export const coreGroup = 'urn:ietf:params:scim:schemas:core:2.0:Group';

export const patch = (Operations: unknown[]) => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations,
});

export function createDirectoryFixture() {
  const api = useOrganizationApi('directory');

  async function setup() {
    const f = await api.setup();
    const organization = f.settings.organization;
    if (organization === null) throw new Error('Organization missing');
    const response = await api.send(
      'POST',
      `/v1/workspaces/${f.workspaceId}/sso/directory/credentials`,
      {
        browser: f.owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          name: 'Provisioning fixture',
          expectedRevision: organization.revision,
        },
      },
    );
    expect(response.statusCode, response.payload).toBe(200);
    const credential = directoryCredentialResultSchema.parse(response.json());
    if (credential.replayed) throw new Error('Fresh credential replayed');
    const headers = {
      authorization: `Bearer ${credential.secret}`,
      'content-type': 'application/scim+json',
      origin: 'https://machine.integration.test',
    };
    const base = `/v1/auth/federation/scim/${organization.id}/v2`;
    return { ...f, credential, headers, base };
  }

  const createPerson = (f: Awaited<ReturnType<typeof setup>>, email: string) =>
    api.send('POST', `${f.base}/Users`, {
      headers: f.headers,
      payload: {
        schemas: [coreUser],
        userName: email,
        active: true,
        emails: [{ value: email, primary: true }],
      },
    });
  return { setup, api, createPerson };
}
